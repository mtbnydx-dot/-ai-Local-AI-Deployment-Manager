"use strict";

// Discovery for the hub (03 §13.2, §13.3): search with a cursor and facets,
// repository detail with the quant table and fit, the readme, the file tree
// and pasted-link resolution. The routes call these through the Hub object
// (index.js); nothing here touches the disk or the queue except to read.
//
//   createDiscovery({ providers, fit, library, queue, auth, settings, clock, logger })
//     → { search(query, ctx), getRepo(ref, opts), getReadme(ref, opts),
//         listFiles(ref, opts), resolveLink(url), libraryStates() }
//
// Search never inspects a remote checkpoint (02 O2): each item carries a
// params-based fitHint. Repository detail inspects the recommended candidate
// once, through fit.inspect(), and grades every other artifact on parameters
// and bytes until the plan sheet inspects the one the user picked.

const crypto = require("node:crypto");
const { HubError } = require("./errors");
const { REPO_RE } = require("./auth");
const { badRequest, fromProviderError, isPlainObject, nonEmpty } = require("./hub-util");
const { listArtifacts } = require("./selection");
const { baseNameOf, detectPrecision, groupPrecisionVariants } = require("../precision-variants");
const { inferRemoteParamsB } = require("../remote-model-utils");
const { DEFAULT_CONTEXT_TOKENS, GGUF_Q4_BYTES_PER_PARAM, enginesForFormat } = require("./fit");

const NAMESPACES = Object.freeze(["huggingface", "modelscope"]);
const SORTS = Object.freeze(["trending", "downloads", "likes", "updated"]);
const FACET_KEYS = Object.freeze(["format", "engine", "fit", "task", "size", "updated", "gated", "modality", "moe"]);
const FORMAT_FACETS = Object.freeze(["gguf", "safetensors", "fp8", "nvfp4", "mxfp4", "awq", "gptq", "bnb"]);
const SIZE_BUCKETS = Object.freeze(["lt8b", "8-16b", "16-40b", "40-80b", "gt80b"]);
const UPDATED_WINDOWS = Object.freeze({ "7d": 7, "30d": 30, "90d": 90, "365d": 365 });
const MODALITIES = Object.freeze(["vision", "audio"]);
const FIT_FACETS = Object.freeze(["fits", "tight", "spills", "wont-fit", "unknown"]);
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;
const MAX_QUERY_LENGTH = 200;
const MAX_CURSOR_LENGTH = 2048;
// The provider is always asked for the same page size, so a cursor stays
// valid when the caller's limit changes between two requests.
const PROVIDER_PAGE_SIZE = 50;
const MAX_PROVIDER_PAGES = 3;
const CURSOR_VERSION = 1;
const FILES_DEFAULT_LIMIT = 500;
const FILES_MAX_LIMIT = 2000;
const MAX_CONTEXT_TOKENS = 4 * 1024 * 1024;
const MAX_INSPECT_ATTEMPTS = 2;
const SIBLING_LIMIT = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
const REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const ENGINE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const TASK_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const DTYPE_BYTES = Object.freeze({
  F32: 4, FP32: 4, F16: 2, FP16: 2, BF16: 2, F8_E4M3: 1, F8_E5M2: 1, FP8: 1, I8: 1, U8: 1, I4: 0.5, U4: 0.5,
});
const FOUR_BIT_FORMATS = new Set(["awq", "gptq", "nvfp4", "mxfp4", "bnb"]);
const PRECISION_FORMAT = Object.freeze({ NVFP4: "nvfp4", MXFP4: "mxfp4", FP8: "fp8", AWQ: "awq", GPTQ: "gptq", "BNB-4bit": "bnb" });
const FORMAT_TAGS = Object.freeze({ fp8: "fp8", awq: "awq", gptq: "gptq", nvfp4: "nvfp4", mxfp4: "mxfp4", bitsandbytes: "bnb" });
const VISION_TAGS = new Set(["image-text-to-text", "vision", "multimodal", "image-to-text", "visual-question-answering", "any-to-any"]);
const AUDIO_TAGS = new Set(["audio", "automatic-speech-recognition", "audio-text-to-text", "text-to-speech", "speech", "audio-to-audio"]);

// ---------------------------------------------------------------------------
// Small helpers

function lower(value) {
  return String(value || "").toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ""))];
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJson(text) {
  if (typeof text !== "string" || !text || text.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const value = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function listFrom(value) {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : String(value).split(",");
}

function namespaceOf(value) {
  const text = lower(value || "huggingface");
  if (!NAMESPACES.includes(text)) throw badRequest("provider", "provider must be huggingface or modelscope.");
  return text;
}

function parseContext(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_CONTEXT_TOKENS;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 512 || number > MAX_CONTEXT_TOKENS) throw badRequest("context", "context must be a whole number of tokens between 512 and 4194304.");
  return number;
}

// ---------------------------------------------------------------------------
// Library and queue state (read-only)

function stateKey(namespace, repo) {
  return `${namespace === "modelscope" ? "modelscope" : "huggingface"}|${lower(repo)}`;
}

function entryHealthy(entry) {
  return entry?.verification?.status !== "fail" && !(Number(entry?.residue?.incompleteFiles) > 0);
}

function entryMatchesArtifact(entry, artifact) {
  const key = entry?.provenance?.artifactKey;
  if (!artifact) return true;
  if (key) return key === artifact.artifactKey;
  // An entry whose artifact is unknown (a legacy marker) matches by quant or format.
  if (artifact.quant && entry.quant) return lower(entry.quant) === lower(artifact.quant);
  return !artifact.quant && lower(entry?.format) === lower(artifact.format);
}

/**
 * The library state of one repository or one artifact:
 * { state: absent|present|partial|update-available, entryId }. Entries come
 * from the registry, running or paused jobs from the queue (a download in
 * progress is "partial").
 */
function stateOf(entries, jobs, { artifact = null, revisionSha = null } = {}) {
  const matched = entries.filter((entry) => entryMatchesArtifact(entry, artifact));
  const healthy = matched.filter(entryHealthy);
  if (healthy.length) {
    const sha = revisionSha || null;
    const stale = healthy.find((entry) => entry.update?.status === "available"
      || (sha && entry.provenance?.revisionSha && entry.provenance.revisionSha !== sha));
    if (stale) return { state: "update-available", entryId: stale.id || null };
    return { state: "present", entryId: healthy[0].id || null };
  }
  if (matched.length) return { state: "partial", entryId: matched[0].id || null };
  const pending = jobs.find((job) => !artifact || !job.artifact?.artifactKey || job.artifact.artifactKey === artifact.artifactKey);
  if (pending) return { state: "partial", entryId: null };
  return { state: "absent", entryId: null };
}

async function loadLibraryStates({ library, queue }) {
  const entriesByRepo = new Map();
  const jobsByRepo = new Map();
  if (library && typeof library.list === "function") {
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      let result = null;
      try {
        result = await library.list({ limit: 500, ...(cursor ? { cursor } : {}) });
      } catch {
        break;
      }
      for (const entry of result?.entries || []) {
        const repo = entry?.provenance?.repo;
        if (!repo) continue;
        const key = stateKey(entry.provenance.provider, repo);
        if (!entriesByRepo.has(key)) entriesByRepo.set(key, []);
        entriesByRepo.get(key).push(entry);
      }
      cursor = result?.nextCursor || null;
      if (!cursor) break;
    }
  }
  if (queue && typeof queue.list === "function") {
    try {
      for (const job of queue.list({ limit: 200 }).jobs || []) {
        if (!job?.artifact?.repo) continue;
        const key = stateKey(job.artifact.provider, job.artifact.repo);
        if (!jobsByRepo.has(key)) jobsByRepo.set(key, []);
        jobsByRepo.get(key).push(job);
      }
    } catch {
      // The queue is a hint here.
    }
  }
  return {
    entriesFor: (namespace, repo) => entriesByRepo.get(stateKey(namespace, repo)) || [],
    jobsFor: (namespace, repo) => jobsByRepo.get(stateKey(namespace, repo)) || [],
    forRepo: (namespace, repo, extra) => stateOf(entriesByRepo.get(stateKey(namespace, repo)) || [], jobsByRepo.get(stateKey(namespace, repo)) || [], extra),
    forArtifact: (namespace, repo, artifact, revisionSha) => stateOf(
      entriesByRepo.get(stateKey(namespace, repo)) || [],
      jobsByRepo.get(stateKey(namespace, repo)) || [],
      { artifact, revisionSha },
    ),
  };
}

// ---------------------------------------------------------------------------
// Search items

function formatsOf(raw) {
  const tags = (raw.tags || []).map(lower);
  const name = lower(String(raw.repo || "").split("/")[1]);
  const formats = new Set();
  if (raw.library === "gguf" || raw.gguf || tags.includes("gguf") || /(?:^|[-_.])gguf(?:$|[-_.])/.test(name)) formats.add("gguf");
  if (raw.safetensors || tags.includes("safetensors")) formats.add("safetensors");
  const precision = PRECISION_FORMAT[detectPrecision(raw.repo)];
  if (precision) formats.add(precision);
  for (const tag of tags) if (FORMAT_TAGS[tag]) formats.add(FORMAT_TAGS[tag]);
  return [...formats];
}

function quantsOf(raw) {
  const text = `${raw.repo} ${(raw.tags || []).join(" ")}`;
  return unique([...text.matchAll(/\bI?Q[2-8](?:_[A-Z0-9]+)*\b/gi)].map((match) => match[0].toUpperCase()));
}

function paramsOf(raw) {
  const total = Number(raw.safetensors?.total) || Number(raw.gguf?.total) || 0;
  if (total > 0) return round(total / 1e9, 2);
  const inferred = inferRemoteParamsB(String(raw.repo || "").split("/")[1] || "");
  return inferred ? round(inferred, 2) : null;
}

// Bytes per parameter for the search hint, where only parameters are known.
function bytesPerParamOf(raw, formats, paramsB) {
  if (formats.includes("gguf") && !formats.some((format) => format !== "gguf")) return GGUF_Q4_BYTES_PER_PARAM;
  const used = Number(raw.usedStorage) || 0;
  if (used > 0 && paramsB) return Math.min(4.5, Math.max(0.3, used / (paramsB * 1e9)));
  if (formats.some((format) => FOUR_BIT_FORMATS.has(format))) return 0.56;
  if (formats.includes("fp8")) return 1;
  const dtypes = raw.safetensors?.parameters;
  if (isPlainObject(dtypes)) {
    let count = 0;
    let bytes = 0;
    for (const [dtype, n] of Object.entries(dtypes)) {
      const width = DTYPE_BYTES[String(dtype).toUpperCase()];
      if (!width || !(Number(n) > 0)) continue;
      count += Number(n);
      bytes += Number(n) * width;
    }
    if (count > 0) return round(bytes / count, 3);
  }
  return 2;
}

function sizeBucket(paramsB) {
  if (!(paramsB > 0)) return null;
  if (paramsB < 8) return "lt8b";
  if (paramsB < 16) return "8-16b";
  if (paramsB < 40) return "16-40b";
  if (paramsB < 80) return "40-80b";
  return "gt80b";
}

function modalitiesOf(raw) {
  const tags = (raw.tags || []).map(lower);
  const tagged = new Set([...tags, lower(raw.pipelineTag)]);
  const result = [];
  if ([...tagged].some((tag) => VISION_TAGS.has(tag))) result.push("vision");
  if ([...tagged].some((tag) => AUDIO_TAGS.has(tag))) result.push("audio");
  return result;
}

function isMoe(raw) {
  const name = lower(String(raw.repo || "").split("/")[1]);
  return (raw.tags || []).map(lower).includes("moe") || /(?:^|[-_.])moe(?:$|[-_.])/.test(name) || /(?:^|[-_.])a\d+(?:\.\d+)?b(?:$|[-_.])/.test(name);
}

function familyKeyOf(raw) {
  if (nonEmpty(raw.baseModel) && raw.baseModel.includes("/")) return lower(raw.baseModel.trim());
  const [author, name] = String(raw.repo || "").split("/");
  return lower(`${author}/${baseNameOf(`${author}/${name}`)}`);
}

function updatedDays(raw, nowMs) {
  const at = Date.parse(raw.lastModified || "");
  return Number.isFinite(at) ? Math.max(0, (nowMs - at) / DAY_MS) : null;
}

// ---------------------------------------------------------------------------
// Query parsing

function parseFacets(input) {
  const pairs = [];
  if (isPlainObject(input)) {
    for (const [key, value] of Object.entries(input)) for (const item of listFrom(value)) pairs.push([key, String(item)]);
  } else {
    for (const text of listFrom(input)) {
      const raw = String(text);
      const at = raw.indexOf(":");
      if (at <= 0) throw badRequest("facet", "facet must look like key:value.");
      pairs.push([raw.slice(0, at), raw.slice(at + 1)]);
    }
  }
  const facets = new Map();
  for (const [rawKey, rawValue] of pairs) {
    const key = lower(rawKey).trim();
    const value = lower(rawValue).trim();
    if (!FACET_KEYS.includes(key)) throw badRequest("facet", `Unknown facet "${key.slice(0, 40)}"; use ${FACET_KEYS.join(", ")}.`);
    if (!value) throw badRequest("facet", `facet ${key} needs a value.`);
    const allowed = {
      format: FORMAT_FACETS,
      size: SIZE_BUCKETS,
      updated: Object.keys(UPDATED_WINDOWS),
      fit: FIT_FACETS,
      modality: MODALITIES,
    }[key];
    if (allowed && !allowed.includes(value)) throw badRequest("facet", `facet ${key} must be one of ${allowed.join(", ")}.`);
    if (key === "engine" && !ENGINE_ID_RE.test(value)) throw badRequest("facet", "facet engine must be an engine id.");
    if (key === "task" && !TASK_RE.test(value)) throw badRequest("facet", "facet task must be a pipeline tag.");
    if ((key === "gated" || key === "moe") && !["true", "false", "1", "0", "yes", "no"].includes(value)) throw badRequest("facet", `facet ${key} must be true or false.`);
    const normalized = key === "gated" || key === "moe" ? (["true", "1", "yes"].includes(value) ? "true" : "false") : value;
    if (!facets.has(key)) facets.set(key, new Set());
    facets.get(key).add(normalized);
  }
  return facets;
}

function parseSearchQuery(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const q = String(input.q ?? "").replace(/\s+/g, " ").trim();
  if (q.length > MAX_QUERY_LENGTH) throw badRequest("q", `q may be at most ${MAX_QUERY_LENGTH} characters.`);
  const namespace = namespaceOf(input.provider);
  const sort = lower(input.sort || "trending");
  if (!SORTS.includes(sort)) throw badRequest("sort", `sort must be one of ${SORTS.join(", ")}.`);
  let limit = DEFAULT_LIMIT;
  if (input.limit !== undefined && input.limit !== null && input.limit !== "") {
    limit = Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1) throw badRequest("limit", "limit must be a positive whole number.");
    limit = Math.min(MAX_LIMIT, limit);
  }
  const cursor = input.cursor === undefined || input.cursor === null || input.cursor === "" ? null : String(input.cursor);
  if (cursor !== null && cursor.length > MAX_CURSOR_LENGTH) throw badRequest("cursor", "The cursor is too long.");
  const facets = parseFacets(input.facets ?? input.facet);
  return { q, namespace, sort, limit, cursor, facets, contextTokens: parseContext(input.context) };
}

// The cursor hash covers what decides which results come next: the namespace,
// the text, the sort and the facets (not limit or context).
function queryHash(query) {
  const facets = [...query.facets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, [...values].sort()]);
  return sha1(JSON.stringify({ p: query.namespace, q: lower(query.q), s: query.sort, f: facets }));
}

function encodeCursor(query, state) {
  return encodeJson({ v: CURSOR_VERSION, p: query.namespace, c: state.c ?? null, o: state.o, h: queryHash(query) });
}

function decodeCursor(query) {
  const decoded = decodeJson(query.cursor);
  if (!decoded || decoded.v !== CURSOR_VERSION || !Number.isInteger(decoded.o) || decoded.o < 0 || decoded.o > 1000
    || (decoded.c !== null && typeof decoded.c !== "string") || typeof decoded.h !== "string") {
    throw new HubError("invalid_cursor", "The cursor is not valid.", { status: 400, details: { field: "cursor" } });
  }
  if (decoded.h !== queryHash(query) || decoded.p !== query.namespace) {
    throw new HubError("cursor_mismatch", "The cursor belongs to a different search; start again without it.", { status: 400, details: { field: "cursor" } });
  }
  return { c: decoded.c, o: decoded.o };
}

// What the provider can filter for us (03 §13.2); everything else is
// post-filtered.
function nativeFilters(query) {
  if (query.namespace !== "huggingface") return {};
  const out = {};
  const formats = query.facets.get("format");
  if (formats && formats.size === 1 && formats.has("gguf")) out.filter = "gguf";
  const tasks = query.facets.get("task");
  if (tasks && tasks.size === 1) out.task = [...tasks][0];
  return out;
}

// The provider whose fetch and endpoint inspectRemote should use: the mirror
// when the manifest came from it (no credentials), else the primary.
function inspectionProviderFor(provider, manifest) {
  const fallback = provider?.fallback;
  if (fallback && manifest?.fetchedFrom && String(manifest.fetchedFrom) === String(fallback.apiBase) && String(fallback.apiBase) !== String(provider.apiBase)) return fallback;
  return provider;
}

// ---------------------------------------------------------------------------

function createDiscovery(options = {}) {
  const providers = options.providers;
  const fit = options.fit;
  const library = options.library || null;
  const queue = options.queue || null;
  const auth = options.auth || null;
  const getSettings = typeof options.settings === "function" ? options.settings : () => options.settings?.get?.() || {};
  const clock = options.clock && typeof options.clock.now === "function" ? options.clock : Date;
  const logger = options.logger || null;

  function debug(line) {
    try {
      logger?.debug?.(line);
    } catch {
      // Logging never breaks a request.
    }
  }

  function metadataProvider(namespace) {
    try {
      return providers.forNamespace(namespace);
    } catch (error) {
      throw fromProviderError(error);
    }
  }

  function libraryStates() {
    return loadLibraryStates({ library, queue });
  }

  // --- search --------------------------------------------------------------

  async function mapItem(raw, env) {
    const formats = formatsOf(raw);
    const paramsB = paramsOf(raw);
    const engines = unique(formats.flatMap(enginesForFormat));
    const primary = formats.find((format) => format !== "gguf") || formats[0] || null;
    let fitHint = { label: "unknown", status: "unknown", neededMb: null, basis: "params" };
    if (paramsB && formats.length) {
      const result = await fit.fitFor({
        legacy: { paramsB, bytesPerParam: bytesPerParamOf(raw, formats, paramsB) },
        bytes: raw.usedStorage || null,
        format: primary,
        contextTokens: env.contextTokens,
        suggestions: false,
      });
      fitHint = { label: result.label, status: result.status, neededMb: result.neededMb, basis: result.basis };
    }
    const owned = env.states.forRepo(raw.namespace, raw.repo);
    return {
      item: {
        provider: raw.namespace,
        repo: raw.repo,
        author: raw.author,
        task: raw.pipelineTag,
        formats,
        quants: quantsOf(raw),
        paramsB,
        downloads: raw.downloads,
        likes: raw.likes,
        lastModified: raw.lastModified,
        gated: Boolean(raw.gated),
        tags: raw.tags || [],
        baseModel: raw.baseModel || null,
        familyKey: familyKeyOf(raw),
        fitHint,
        engines,
        library: { state: owned.state, entryId: owned.entryId },
      },
      meta: { size: sizeBucket(paramsB), days: updatedDays(raw, env.nowMs), modalities: modalitiesOf(raw), moe: isMoe(raw) },
    };
  }

  function facetMatches(query, item, meta) {
    for (const [key, wanted] of query.facets) {
      let ok = false;
      for (const value of wanted) {
        switch (key) {
          case "format": ok = item.formats.includes(value); break;
          case "engine": ok = item.engines.includes(value); break;
          case "fit": ok = item.fitHint.label === value; break;
          case "task": ok = lower(item.task) === value; break;
          case "size": ok = meta.size === value; break;
          case "updated": ok = meta.days !== null && meta.days <= UPDATED_WINDOWS[value]; break;
          case "gated": ok = String(item.gated) === value; break;
          case "modality": ok = meta.modalities.includes(value); break;
          case "moe": ok = String(meta.moe) === value; break;
          default: ok = false;
        }
        if (ok) break;
      }
      if (!ok) return false;
    }
    return true;
  }

  function countFacets(rows) {
    const counts = Object.fromEntries(FACET_KEYS.map((key) => [key, new Map()]));
    const bump = (key, value) => {
      if (value === undefined || value === null || value === "") return;
      counts[key].set(value, (counts[key].get(value) || 0) + 1);
    };
    for (const { item, meta } of rows) {
      for (const format of item.formats) bump("format", format);
      for (const engine of item.engines) bump("engine", engine);
      if (item.fitHint.label !== "unknown") bump("fit", item.fitHint.label);
      bump("task", lower(item.task));
      bump("size", meta.size);
      for (const [window, days] of Object.entries(UPDATED_WINDOWS)) if (meta.days !== null && meta.days <= days) bump("updated", window);
      if (item.gated) bump("gated", "true");
      for (const modality of meta.modalities) bump("modality", modality);
      if (meta.moe) bump("moe", "true");
    }
    return Object.fromEntries(FACET_KEYS.map((key) => [
      key,
      [...counts[key].entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([value, count]) => ({ value, count })),
    ]));
  }

  function groupFamilies(items) {
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.familyKey)) groups.set(item.familyKey, []);
      groups.get(item.familyKey).push(item.repo);
    }
    return [...groups.entries()].filter(([, repos]) => repos.length > 1).map(([familyKey, repos]) => ({ familyKey, repos }));
  }

  /**
   * search(query, ctx) → the 03 §13.2 body (without `ok`). `query`: { q,
   * provider, sort, limit, cursor, facets (facet=key:value strings, or an
   * object), context }. A cursor from another query is 400 cursor_mismatch.
   */
  async function search(rawQuery, ctx = {}) {
    const query = parseSearchQuery(rawQuery);
    const resume = query.cursor ? decodeCursor(query) : { c: null, o: 0 };
    const provider = metadataProvider(query.namespace);
    const native = nativeFilters(query);
    const states = await libraryStates();
    const env = { states, contextTokens: query.contextTokens, nowMs: clock.now() };
    const rows = [];
    const warnings = [];
    let fetchedFrom = null;
    let pageCursor = resume.c;
    let offset = resume.o;
    let next = null;
    for (let pages = 0; pages < MAX_PROVIDER_PAGES && rows.length < query.limit; pages += 1) {
      let page;
      try {
        page = await provider.search({
          q: query.q,
          sort: query.sort,
          limit: PROVIDER_PAGE_SIZE,
          ...(pageCursor ? { cursor: pageCursor } : {}),
          ...native,
          signal: ctx.signal,
        });
      } catch (error) {
        throw fromProviderError(error);
      }
      fetchedFrom = page.fetchedFrom || fetchedFrom;
      for (const warning of page.warnings || []) warnings.push(warning);
      const items = Array.isArray(page.items) ? page.items : [];
      let index = offset;
      for (; index < items.length && rows.length < query.limit; index += 1) {
        const mapped = await mapItem(items[index], env);
        if (facetMatches(query, mapped.item, mapped.meta)) rows.push(mapped);
      }
      if (index < items.length) {
        next = { c: pageCursor, o: index };
        break;
      }
      pageCursor = page.nextCursor || null;
      offset = 0;
      next = pageCursor ? { c: pageCursor, o: 0 } : null;
      if (!pageCursor) break;
    }
    const items = rows.map((row) => row.item);
    return {
      provider: query.namespace,
      fetchedFrom: fetchedFrom || "",
      items,
      families: groupFamilies(items),
      facets: countFacets(rows),
      nextCursor: next ? encodeCursor(query, next) : null,
      // Short because the page budget ran out, not because the results did.
      partial: Boolean(next) && rows.length < query.limit,
      warnings,
    };
  }

  // --- repository detail -----------------------------------------------------

  function parseRef(ref) {
    const input = isPlainObject(ref) ? ref : {};
    const namespace = namespaceOf(input.provider);
    const repo = nonEmpty(input.repo) ? input.repo.trim() : `${input.owner || ""}/${input.name || ""}`;
    if (!REPO_RE.test(repo)) throw badRequest("repo", "repo must look like owner/name.");
    return { namespace, repo };
  }

  function parseRevision(value) {
    const revision = value === undefined || value === null || value === "" ? "main" : String(value);
    if (!REVISION_RE.test(revision)) throw badRequest("revision", "The revision is not valid.");
    return revision;
  }

  async function fetchManifest(provider, repo, revision, signal) {
    try {
      return await provider.getRepo(repo, { revision, signal });
    } catch (error) {
      throw fromProviderError(error);
    }
  }

  function manifestParamsB(manifest) {
    const total = Number(manifest.structured?.safetensors?.total) || Number(manifest.structured?.gguf?.total) || 0;
    if (total > 0) return round(total / 1e9, 2);
    const inferred = inferRemoteParamsB(String(manifest.repo || "").split("/")[1] || "");
    return inferred ? round(inferred, 2) : null;
  }

  // Higher bits first, then the K-quant size letter (XL > L > M > S > XS).
  function quantRank(artifact) {
    const label = String(artifact.quant || artifact.label || "");
    const bits = Number((/(\d+)/.exec(label) || [])[1]) || 0;
    const size = /_XL$/i.test(label) ? 4 : /_L$/i.test(label) ? 3 : /_M$/i.test(label) ? 2 : /_S$/i.test(label) ? 1 : 0;
    return bits * 10 + size;
  }

  function parseGpuIds(value) {
    const ids = listFrom(value).map((item) => String(item).trim()).filter(Boolean);
    for (const id of ids) if (!/^[A-Za-z0-9:_-]{1,64}$/.test(id)) throw badRequest("gpuIds", "gpuIds must be a list of GPU ids.");
    return ids.length ? ids : null;
  }

  function parseEngine(value) {
    if (value === undefined || value === null || value === "") return null;
    const engineId = String(value);
    if (!ENGINE_ID_RE.test(engineId)) throw badRequest("engineId", "engineId must be an engine id.");
    return engineId;
  }

  async function accessOf(namespace, manifest, { revision, signal } = {}) {
    if (!manifest.gated || namespace !== "huggingface") {
      return { gated: Boolean(manifest.gated), status: "not_required", authorizationUrl: null };
    }
    const settings = getSettings();
    const officialOnly = settings?.sources?.gatedUsesOfficial === false;
    const mirrored = Boolean(manifest.fetchedFrom) && settings?.sources?.mirrorEndpoint && String(manifest.fetchedFrom).startsWith(String(settings.sources.mirrorEndpoint));
    if (mirrored && officialOnly) return { gated: true, status: "official_required", authorizationUrl: null };
    if (!auth || typeof auth.access !== "function") return { gated: true, status: "unknown", authorizationUrl: null };
    try {
      const result = await auth.access({ repo: manifest.repo, revision });
      const status = { granted: "granted", login_required: "login_required", invalid_token: "login_required", approval_required: "approval_required" }[result?.status] || "unknown";
      return { gated: true, status, authorizationUrl: result?.authorizationUrl || null };
    } catch (error) {
      debug(`hub: the access check for ${manifest.repo} failed: ${error?.code || error?.message || error}`);
      return { gated: true, status: "unknown", authorizationUrl: null };
    }
  }

  async function siblingsOf(namespace, provider, manifest, signal) {
    try {
      const base = baseNameOf(manifest.repo);
      if (!base) return [];
      const page = await provider.search({ q: base, sort: "downloads", limit: 30, signal });
      const candidates = (page.items || []).map((raw) => ({ id: raw.repo, downloads: raw.downloads, likes: raw.likes, gated: raw.gated }));
      return groupPrecisionVariants(manifest.repo, candidates).variants
        .filter((variant) => !variant.isCurrent)
        .slice(0, SIBLING_LIMIT)
        .map((variant) => ({ repo: variant.id, precision: variant.precision }));
    } catch (error) {
      debug(`hub: sibling repositories of ${manifest.repo} could not be listed: ${error?.code || error?.message || error}`);
      return [];
    }
  }

  /**
   * getRepo({ provider, repo | owner + name }, { revision, contextTokens,
   * gpuIds, engineId, signal }) → the 03 §13.3 body (without `ok`). Every
   * artifact carries its fit (basis params), engines, recommended flag and
   * library state; the recommended candidate is graded from a remote card.
   */
  async function getRepo(ref, opts = {}) {
    const { namespace, repo } = parseRef(ref);
    const revision = parseRevision(opts.revision);
    const contextTokens = parseContext(opts.contextTokens ?? opts.context);
    const gpuIds = parseGpuIds(opts.gpuIds);
    const engineOverride = parseEngine(opts.engineId);
    const provider = metadataProvider(namespace);
    const manifest = await fetchManifest(provider, repo, revision, opts.signal);
    const warnings = Array.isArray(manifest.warnings) ? manifest.warnings.map((warning) => ({ ...warning })) : [];

    const states = await libraryStates();
    const all = listArtifacts(manifest, { includeIncomplete: true });
    for (const artifact of all.filter((item) => !item.complete)) {
      warnings.push({
        code: "incomplete_artifact",
        message: { zh: `${artifact.label} 的分片不完整，已隐藏。`, en: `${artifact.label} has an incomplete shard set and is hidden.` },
        artifactKey: artifact.artifactKey,
      });
    }
    const paramsB = manifestParamsB(manifest);
    const rows = [];
    for (const artifact of all.filter((item) => item.complete)) {
      const engineId = engineOverride || fit.engineFor(artifact.format);
      const result = await fit.fitFor({
        legacy: paramsB && artifact.bytes > 0 ? { paramsB, bytesPerParam: artifact.bytes / (paramsB * 1e9) } : null,
        bytes: artifact.bytes,
        format: artifact.format,
        engineId,
        contextTokens,
        gpuIds,
      });
      rows.push({
        artifact,
        engineId,
        view: {
          artifactKey: artifact.artifactKey,
          kind: artifact.kind,
          label: artifact.label,
          format: artifact.format,
          quant: artifact.quant,
          bytes: artifact.bytes,
          fileCount: artifact.fileCount,
          multiPart: Boolean(artifact.multiPart),
          complete: Boolean(artifact.complete),
          companions: artifact.companions,
          fit: result,
          engines: enginesForFormat(artifact.format).map((id) => ({ engineId: id, basis: "format" })),
          recommended: false,
          library: states.forArtifact(namespace, repo, artifact, manifest.revisionSha),
        },
      });
    }

    // The recommended candidate (03 §13.3): the largest artifact that fits,
    // ties to the higher quant. It is graded once more from a remote card; one
    // that no longer fits is passed over for the next (at most two cards).
    const candidates = rows.filter((row) => row.view.fit.label === "fits")
      .sort((a, b) => b.artifact.bytes - a.artifact.bytes || quantRank(b.artifact) - quantRank(a.artifact));
    const inspectTargets = candidates.length ? candidates.slice(0, MAX_INSPECT_ATTEMPTS)
      : rows.length ? [[...rows].sort((a, b) => b.artifact.bytes - a.artifact.bytes)[0]] : [];
    const inspector = inspectionProviderFor(provider, manifest);
    let card = null;
    let recommended = null;
    let inspectFailed = false;
    for (const row of inspectTargets) {
      const inspected = await fit.inspect({
        provider: inspector,
        namespace,
        repo,
        revision,
        revisionSha: manifest.revisionSha,
        files: row.artifact.files.map((file) => file.path),
        signal: opts.signal,
      });
      if (!inspected) {
        inspectFailed = true;
        if (candidates.length && !recommended) recommended = row;
        break;
      }
      card = card || inspected;
      if (!candidates.length) break;
      const graded = await fit.fitFor({ card: inspected, bytes: row.artifact.bytes, format: row.artifact.format, engineId: row.engineId, contextTokens, gpuIds });
      row.view.fit = graded;
      if (graded.label === "fits") {
        recommended = row;
        card = inspected;
        break;
      }
    }
    if (recommended) recommended.view.recommended = true;
    if (inspectFailed && fit.hasModels) {
      warnings.push({
        code: "inspect_unavailable",
        message: { zh: "没有读取到远端模型头信息，适配度只按参数量估算。", en: "The remote model header could not be read; fit is estimated from parameters only." },
      });
    }

    const compatibility = await fit.compatibilityFor(card);
    const access = await accessOf(namespace, manifest, { revision, signal: opts.signal });
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    return {
      provider: namespace,
      repo,
      revision,
      revisionSha: manifest.revisionSha || null,
      fetchedFrom: manifest.fetchedFrom || "",
      summary: {
        task: manifest.pipelineTag || null,
        license: manifest.license || null,
        baseModel: manifest.baseModel || null,
        paramsB,
        contextLength: manifest.structured?.gguf?.context_length ?? null,
        lastModified: manifest.lastModified || null,
      },
      access,
      files: {
        count: files.length,
        totalBytes: files.reduce((sum, file) => sum + (Number(file.size) || 0), 0),
        truncated: Boolean(manifest.filesTruncated),
      },
      artifacts: rows.map((row) => row.view),
      card: card ? { cardId: card.cardId, identity: card.identity, role: card.role, evidence: card.evidence } : null,
      compatibility,
      siblingRepos: await siblingsOf(namespace, provider, manifest, opts.signal),
      warnings,
    };
  }

  async function getReadme(ref, opts = {}) {
    const { namespace, repo } = parseRef(ref);
    const revision = parseRevision(opts.revision);
    const provider = metadataProvider(namespace);
    const manifest = await fetchManifest(provider, repo, revision, opts.signal);
    let readme;
    try {
      readme = await provider.getReadme(repo, { revision, signal: opts.signal });
    } catch (error) {
      throw fromProviderError(error);
    }
    return { markdown: String(readme?.markdown || ""), truncated: Boolean(readme?.truncated), revisionSha: manifest.revisionSha || null };
  }

  /** The manifest's files, sorted by path, paged by an opaque offset cursor. */
  async function listFiles(ref, opts = {}) {
    const { namespace, repo } = parseRef(ref);
    const revision = parseRevision(opts.revision);
    let limit = FILES_DEFAULT_LIMIT;
    if (opts.limit !== undefined && opts.limit !== null && opts.limit !== "") {
      limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1) throw badRequest("limit", "limit must be a positive whole number.");
      limit = Math.min(FILES_MAX_LIMIT, limit);
    }
    let offset = 0;
    if (opts.cursor) {
      const decoded = decodeJson(String(opts.cursor));
      if (!decoded || decoded.v !== CURSOR_VERSION || !Number.isInteger(decoded.o) || decoded.o < 0 || decoded.k !== "files") {
        throw new HubError("invalid_cursor", "The cursor is not valid.", { status: 400, details: { field: "cursor" } });
      }
      offset = decoded.o;
    }
    const provider = metadataProvider(namespace);
    const manifest = await fetchManifest(provider, repo, revision, opts.signal);
    const sorted = [...(manifest.files || [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const page = sorted.slice(offset, offset + limit).map((file) => ({ path: file.path, size: file.size ?? null, sha256: file.sha256 || null, lfs: Boolean(file.lfs) }));
    return {
      files: page,
      total: sorted.length,
      nextCursor: offset + limit < sorted.length ? encodeJson({ v: CURSOR_VERSION, k: "files", o: offset + limit }) : null,
      revisionSha: manifest.revisionSha || null,
      truncated: Boolean(manifest.filesTruncated),
    };
  }

  // --- pasted links ----------------------------------------------------------

  const HF_HOSTS = new Set(["huggingface.co", "www.huggingface.co", "hf.co", "hf-mirror.com", "www.hf-mirror.com"]);
  const MS_HOSTS = new Set(["modelscope.cn", "www.modelscope.cn", "modelscope.ai", "www.modelscope.ai"]);

  function unrecognized(message) {
    return new HubError("unrecognized_link", message, { status: 422, details: { field: "url" } });
  }

  function decodePart(part) {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  }

  /**
   * resolveLink(url) → { provider, repo, revision, file? }. Takes a model page,
   * a tree/blob/resolve link on Hugging Face (or its mirror) or ModelScope, or a bare owner/name.
   * It reads the text only; nothing is fetched.
   */
  function resolveLink(input) {
    const text = String(input ?? "").trim();
    if (!text || text.length > 2048) throw badRequest("url", "Paste a model page link or an owner/name id.");
    if (REPO_RE.test(text)) return { provider: "huggingface", repo: text, revision: "main" };
    let url;
    try {
      url = new URL(text);
    } catch {
      throw badRequest("url", "That is not a link or an owner/name id.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw badRequest("url", "Only http and https links are supported.");
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean).map(decodePart);
    let namespace;
    let rest;
    if (HF_HOSTS.has(host)) {
      namespace = "huggingface";
      if (parts[0] === "datasets" || parts[0] === "spaces") throw unrecognized("Only model repositories can be downloaded.");
      rest = parts[0] === "models" ? parts.slice(1) : parts;
    } else if (MS_HOSTS.has(host)) {
      namespace = "modelscope";
      if (parts[0] !== "models") throw unrecognized("Only model repositories can be downloaded.");
      rest = parts.slice(1);
    } else {
      throw unrecognized("Only Hugging Face and ModelScope links are supported.");
    }
    if (rest.length < 2) throw unrecognized("The link does not name a model repository.");
    const repo = `${rest[0]}/${rest[1]}`;
    if (!REPO_RE.test(repo)) throw unrecognized("The link does not name a valid model repository.");
    const tail = rest.slice(2);
    const defaultRevision = namespace === "modelscope" ? "master" : "main";
    let revision = defaultRevision;
    let file;
    const view = tail[0] === "file" && tail[1] === "view" ? 2 : ["tree", "blob", "resolve", "raw"].includes(tail[0]) ? 1 : -1;
    if (view > 0 && tail.length > view) {
      revision = tail[view];
      if (!REVISION_RE.test(revision)) throw unrecognized("The link carries an invalid revision.");
      const fileParts = tail.slice(view + 1);
      if (fileParts.length && tail[0] !== "tree") file = fileParts.join("/");
    }
    return { provider: namespace, repo, revision, ...(file ? { file } : {}) };
  }

  return { search, getRepo, getReadme, listFiles, resolveLink, libraryStates };
}

module.exports = {
  DEFAULT_LIMIT,
  FACET_KEYS,
  MAX_LIMIT,
  createDiscovery,
  decodeCursor,
  encodeCursor,
  inspectionProviderFor,
  loadLibraryStates,
  parseSearchQuery,
  queryHash,
  stateOf,
};
