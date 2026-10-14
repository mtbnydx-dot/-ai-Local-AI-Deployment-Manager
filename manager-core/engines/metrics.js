"use strict";

// Engine metrics (docs/overhaul/01-engines.md §16.1, 00 §9.12): the only
// Prometheus parser on the platform, the descriptor-driven mapping onto the
// canonical camelCase keys, the per-instance summary, and the per-manager
// sampler behind GET /api/instances/:id/metrics.
//
//   parsePrometheus(text)            → { samples:[{name, labels, value}], types:{family: kind} }
//   mapPrometheus(engineId, parsed)  → { processStartSeconds, models:[CanonicalModelMetrics], unsupported:[path] }
//   summarize(mapped, {previous?})   → CanonicalMetrics (flat; histograms → {avg, p50, p95, count})
//   deltaCumulative / quantile       → the histogram helpers 04 uses (telemetry/histogram.js)
//
// mapPrometheus output is cumulative, exactly as the engine exposes it; the 04
// runtime collector computes its deltas from it. The sampler scrapes in the
// background, so a request for an instance's metrics never touches an engine
// or Docker.

const { deltaCumulative, mergeHist, quantile } = require("../telemetry/histogram");
const { METRIC_DERIVE_PATTERN, UNKNOWN_ENGINE_ID, isPlainObject } = require("./descriptor-schema");
const { getEngineRegistry, normalizeManagerId } = require("./registry");
const { runtimeForImage } = require("../runtime-manifest");

const MAX_METRICS_TEXT_BYTES = 4 * 1024 * 1024;
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_CONCURRENCY = 4;
const MAX_INSTANCE_ID_LENGTH = 256;

// The canonical keys of 01 §16.1 and the part of a CanonicalModelMetrics each
// one lives in. A descriptor (or an override) may map further camelCase keys;
// those go where their first source's kind puts them.
const CANONICAL_METRIC_KEYS = Object.freeze({
  counters: Object.freeze([
    "promptTokensTotal",
    "generationTokensTotal",
    "cachedPromptTokensTotal",
    "requestsTotal",
    "requestsByFinishReason",
    "prefixQueriesTotal",
    "prefixHitsTotal",
    "preemptionsTotal",
    "specDraftTokensTotal",
    "specAcceptedTokensTotal",
    "specDraftsTotal",
  ]),
  gauges: Object.freeze([
    "requestsRunning",
    "requestsWaiting",
    "kvUsageRatio",
    "kvCapacityTokens",
    "specAcceptRate",
    "genThroughputTps",
  ]),
  histograms: Object.freeze([
    "ttftSeconds",
    "itlSeconds",
    "tpotSeconds",
    "e2eSeconds",
    "queueSeconds",
  ]),
});
const GROUPS = Object.freeze(["counters", "gauges", "histograms"]);
const GROUP_OF_KEY = new Map(GROUPS.flatMap((group) => CANONICAL_METRIC_KEYS[group].map((key) => [key, group])));
const GROUP_OF_KIND = Object.freeze({ counter: "counters", gauge: "gauges", histogram: "histograms" });
// 04 §7.1 reads the finish-reason split under this name; it is the same object
// as counters.requestsByFinishReason and is never listed as unsupported.
const FINISH_REASON_KEY = "requestsByFinishReason";
const FINISH_REASON_ALIAS = "requestsByFinishReasonTotal";
const PROCESS_START_METRIC = "process_start_time_seconds";
// The route's errorCode values besides http_<status> (01 §16.1). "unreachable"
// covers a refused connection and an engine key the manager cannot read.
const ERROR_CODES = Object.freeze(["no_sample", "timeout", "unsupported_endpoint", "parse_error", "unreachable"]);

const METRIC_NAME_PATTERN = /^[A-Za-z_:][A-Za-z0-9_:]*/;
const LABEL_NAME_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/y;
const KNOWN_TYPES = new Set(["counter", "gauge", "histogram", "untyped"]);
const FAMILY_SUFFIXES = ["_bucket", "_count", "_sum", "_total", "_created", "_info"];

function metricsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// A gauge whose canonical name is a ratio or a rate (kvUsageRatio,
// specAcceptRate) is not additive: across label sets and models it takes the
// largest value instead of the sum, so data-parallel replicas never report a
// KV usage above 1.
function isRatioKey(key) {
  return /(?:Ratio|Rate)$/.test(key);
}

// ---------------------------------------------------------------------------
// parsePrometheus

function parseLabelSet(line, start) {
  const labels = {};
  let index = start;
  const skipSpaces = () => {
    while (line[index] === " " || line[index] === "\t") index += 1;
  };
  for (;;) {
    skipSpaces();
    if (line[index] === "}") return { labels, end: index + 1 };
    LABEL_NAME_PATTERN.lastIndex = index;
    const nameMatch = LABEL_NAME_PATTERN.exec(line);
    if (!nameMatch) return null;
    const name = nameMatch[0];
    index = LABEL_NAME_PATTERN.lastIndex;
    skipSpaces();
    if (line[index] !== "=") return null;
    index += 1;
    skipSpaces();
    if (line[index] !== "\"") return null;
    index += 1;
    let value = "";
    let closed = false;
    while (index < line.length) {
      const char = line[index];
      if (char === "\\") {
        const next = line[index + 1];
        value += next === "n" ? "\n" : next === undefined ? "\\" : next;
        index += 2;
        continue;
      }
      if (char === "\"") {
        closed = true;
        index += 1;
        break;
      }
      value += char;
      index += 1;
    }
    if (!closed) return null;
    // A label named __proto__ would reach the prototype through the setter.
    if (name !== "__proto__" && !Object.hasOwn(labels, name)) labels[name] = value;
    skipSpaces();
    if (line[index] === ",") {
      index += 1;
      continue;
    }
    if (line[index] === "}") return { labels, end: index + 1 };
    return null;
  }
}

function parseSampleValue(token) {
  if (token === "NaN") return NaN;
  if (token === "+Inf" || token === "Inf") return Infinity;
  if (token === "-Inf") return -Infinity;
  if (!token || !/^[-+]?(?:\d|\.\d)/.test(token)) return NaN;
  return Number(token);
}

function parseSampleLine(line) {
  const nameMatch = METRIC_NAME_PATTERN.exec(line);
  if (!nameMatch) return null;
  const name = nameMatch[0];
  let index = name.length;
  let labels = {};
  if (line[index] === "{") {
    const parsed = parseLabelSet(line, index + 1);
    if (!parsed) return null;
    labels = parsed.labels;
    index = parsed.end;
  }
  if (line[index] !== " " && line[index] !== "\t") return null;
  const [valueToken] = line.slice(index).trim().split(/\s+/);
  const value = parseSampleValue(valueToken);
  // NaN and ±Inf carry no usable reading (the managers' parser drops them too).
  if (!Number.isFinite(value)) return null;
  return { name, labels, value };
}

function familyOf(name, types) {
  if (Object.hasOwn(types, name)) return name;
  for (const suffix of FAMILY_SUFFIXES) {
    if (name.endsWith(suffix) && Object.hasOwn(types, name.slice(0, -suffix.length))) return name.slice(0, -suffix.length);
  }
  return null;
}

/**
 * Prometheus text format 0.0.4, at most 4 MiB. Tolerant: a malformed line is
 * skipped, never fatal. types maps each `# TYPE` family to counter, gauge,
 * histogram or untyped (summary and the OpenMetrics-only kinds read as
 * untyped); a sample that belongs to no declared family is its own untyped
 * family.
 */
function parsePrometheus(text) {
  const source = Buffer.isBuffer(text) ? text.toString("utf8") : String(text ?? "");
  if (source.length > MAX_METRICS_TEXT_BYTES || Buffer.byteLength(source, "utf8") > MAX_METRICS_TEXT_BYTES) {
    throw metricsError("metrics_too_large", `The metrics text is larger than ${MAX_METRICS_TEXT_BYTES / (1024 * 1024)} MiB.`);
  }
  const samples = [];
  const types = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const parts = line.slice(1).trim().split(/\s+/);
      if (parts[0] === "TYPE" && parts[1] && METRIC_NAME_PATTERN.test(parts[1]) && parts[1] !== "__proto__") {
        const kind = String(parts[2] || "").toLowerCase();
        types[parts[1]] = KNOWN_TYPES.has(kind) ? kind : "untyped";
      }
      continue;
    }
    const sample = parseSampleLine(line);
    if (sample) samples.push(sample);
  }
  for (const sample of samples) {
    if (!familyOf(sample.name, types) && sample.name !== "__proto__") types[sample.name] = "untyped";
  }
  return { samples, types };
}

// ---------------------------------------------------------------------------
// mapPrometheus

function sourceGroup(sources) {
  const first = Array.isArray(sources) ? sources.find((source) => isPlainObject(source)) : null;
  if (!first) return "gauges";
  return GROUP_OF_KIND[first.kind] || "gauges";
}

// Every canonical key plus any further key the descriptor maps, each with its
// group and ordered sources.
function metricKeysFor(map) {
  const keys = [];
  const seen = new Set();
  for (const group of GROUPS) {
    for (const key of CANONICAL_METRIC_KEYS[group]) {
      keys.push({ key, group, sources: Array.isArray(map[key]) ? map[key] : [] });
      seen.add(key);
    }
  }
  for (const [key, sources] of Object.entries(map)) {
    if (seen.has(key) || key === FINISH_REASON_ALIAS) continue;
    keys.push({ key, group: sourceGroup(sources), sources: Array.isArray(sources) ? sources : [] });
    seen.add(key);
  }
  return keys;
}

function referencedNames(keys) {
  const names = new Set();
  for (const { sources } of keys) {
    for (const source of sources) {
      if (!isPlainObject(source) || typeof source.name !== "string") continue;
      if (source.kind === "histogram") {
        for (const suffix of ["_bucket", "_sum", "_count"]) names.add(`${source.name}${suffix}`);
      } else {
        names.add(source.name);
      }
    }
  }
  return names;
}

function sumValues(samples) {
  let total = 0;
  for (const sample of samples) total += sample.value;
  return total;
}

function scaleOf(source) {
  return typeof source.scale === "number" && Number.isFinite(source.scale) ? source.scale : 1;
}

function boundOf(text) {
  if (text === "+Inf" || text === "Inf" || text === "inf") return Infinity;
  const value = Number(text);
  return text === undefined || text === "" || Number.isNaN(value) ? NaN : value;
}

// Cumulative histogram in the telemetry/histogram.js shape. Buckets with the
// same bound (other labels differ) are summed; a missing +Inf bucket is taken
// from _count.
function readHistogram(name, samplesByName, scale) {
  const buckets = samplesByName.get(`${name}_bucket`) || [];
  const sums = samplesByName.get(`${name}_sum`) || [];
  const counts = samplesByName.get(`${name}_count`) || [];
  if (!buckets.length && !counts.length) return null;
  const byBound = new Map();
  for (const sample of buckets) {
    const bound = boundOf(sample.labels.le);
    if (Number.isNaN(bound)) continue;
    byBound.set(bound, (byBound.get(bound) || 0) + sample.value);
  }
  const bounds = [...byBound.keys()].sort((a, b) => a - b);
  const finite = bounds.filter((bound) => bound !== Infinity);
  let count = counts.length ? sumValues(counts) : byBound.get(Infinity) ?? null;
  if (count === null) count = finite.length ? byBound.get(finite[finite.length - 1]) : 0;
  const infinite = byBound.has(Infinity) ? byBound.get(Infinity) : count;
  return {
    le: [...finite.map((bound) => bound * scale), "+Inf"],
    counts: [...finite.map((bound) => byBound.get(bound)), infinite],
    sum: sums.length ? sumValues(sums) * scale : null,
    count,
  };
}

function readPath(object, path) {
  let value = object;
  for (const part of path.split(".")) {
    if (!isPlainObject(value) || !Object.hasOwn(value, part)) return null;
    value = value[part];
  }
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

/**
 * derive sources read values the manager supplies next to the scrape
 * (`options.derived`): "name" or "a/b", where each name is a dotted path, e.g.
 * "busySlots/nSlots" or "cacheHit.cachedTokens". A ratio with a zero or
 * missing denominator has no value.
 */
function evaluateDerive(expression, derived) {
  if (!isPlainObject(derived) || typeof expression !== "string" || !METRIC_DERIVE_PATTERN.test(expression)) return null;
  const [numeratorPath, denominatorPath] = expression.split("/");
  const numerator = readPath(derived, numeratorPath);
  if (numerator === null) return null;
  if (denominatorPath === undefined) return numerator;
  const denominator = readPath(derived, denominatorPath);
  return denominator ? numerator / denominator : null;
}

// One source for one model -> its value, or null when the source is absent.
function readSource(source, key, samplesByName, derived) {
  if (!isPlainObject(source)) return null;
  if (typeof source.derive === "string") return derived ? evaluateDerive(source.derive, derived) : null;
  // pick/ratio sources belong to JSON payloads, which an adapter maps itself
  // (01 §16.1 format "json"); they never match Prometheus text.
  if (typeof source.name !== "string") return null;
  const scale = scaleOf(source);
  if (source.kind === "histogram") return readHistogram(source.name, samplesByName, scale);
  const samples = samplesByName.get(source.name);
  if (!samples?.length) return null;
  if (typeof source.label === "string" && source.label) {
    const split = {};
    for (const sample of samples) {
      const part = sample.labels[source.label] || "unknown";
      if (part === "__proto__") continue;
      split[part] = (split[part] || 0) + sample.value * scale;
    }
    return split;
  }
  if (source.kind === "gauge" && isRatioKey(key)) return Math.max(...samples.map((sample) => sample.value)) * scale;
  return sumValues(samples) * scale;
}

function resolveDescriptor(engineId, options) {
  if (isPlainObject(options.descriptor)) return options.descriptor;
  const registry = options.registry || getEngineRegistry();
  return registry.require(engineId);
}

/**
 * mapPrometheus(engineId, parsed, { registry?, descriptor?, derived?, defaultModel? })
 *
 * Maps a parsePrometheus result onto the canonical keys through the engine
 * descriptor's metricsMap: per key, the first present source wins. Samples are
 * grouped by their model_name label and every other label is summed (ratio
 * gauges take the maximum). Samples without model_name belong to the only
 * labelled model, or else to one model named `defaultModel`. `derived` feeds
 * derive sources and applies only when there is a single model. Every
 * canonical key appears in each model (null when absent); a key no model has
 * is listed in unsupported as "<group>.<key>". Values stay cumulative.
 */
function mapPrometheus(engineId, parsed, options = {}) {
  const descriptor = resolveDescriptor(engineId, options);
  const map = isPlainObject(descriptor?.metricsMap?.map) ? descriptor.metricsMap.map : {};
  const samples = Array.isArray(parsed?.samples) ? parsed.samples : [];
  const derived = isPlainObject(options.derived) ? options.derived : null;
  const defaultModel = typeof options.defaultModel === "string" && options.defaultModel ? options.defaultModel : null;
  const keys = metricKeysFor(map);
  const referenced = referencedNames(keys);

  let processStartSeconds = null;
  const labelled = [];
  const relevant = [];
  for (const sample of samples) {
    if (processStartSeconds === null && sample.name === PROCESS_START_METRIC) processStartSeconds = sample.value;
    if (!referenced.has(sample.name)) continue;
    relevant.push(sample);
    const model = sample.labels.model_name;
    if (typeof model === "string" && model && !labelled.includes(model)) labelled.push(model);
  }

  const DEFAULT_GROUP = "\u0000default";
  const groups = new Map();
  const groupFor = (key) => {
    if (!groups.has(key)) groups.set(key, new Map());
    return groups.get(key);
  };
  for (const sample of relevant) {
    const model = sample.labels.model_name;
    const key = typeof model === "string" && model ? model : labelled.length === 1 ? labelled[0] : DEFAULT_GROUP;
    const byName = groupFor(key);
    if (!byName.has(sample.name)) byName.set(sample.name, []);
    byName.get(sample.name).push(sample);
  }
  const derivedApplies = derived && groups.size <= 1;
  if (derivedApplies && groups.size === 0) groupFor(DEFAULT_GROUP);

  const present = new Set();
  const models = [...groups.entries()].map(([groupKey, samplesByName]) => {
    const model = { model: groupKey === DEFAULT_GROUP ? defaultModel : groupKey, counters: {}, gauges: {}, histograms: {} };
    for (const { key, group, sources } of keys) {
      let value = null;
      for (const source of sources) {
        value = readSource(source, key, samplesByName, derivedApplies ? derived : null);
        if (value !== null) break;
      }
      model[group][key] = value;
      if (value !== null) present.add(key);
    }
    if (Object.hasOwn(model.counters, FINISH_REASON_KEY)) {
      const split = model.counters[FINISH_REASON_KEY];
      model.counters[FINISH_REASON_ALIAS] = split ? { ...split } : null;
    }
    return model;
  });

  const unsupported = keys.filter(({ key }) => !present.has(key)).map(({ key, group }) => `${group}.${key}`);
  return { processStartSeconds, models, unsupported };
}

// ---------------------------------------------------------------------------
// summarize

function addSplit(target, split) {
  const out = target ? { ...target } : {};
  for (const [part, value] of Object.entries(split)) {
    if (part === "__proto__") continue;
    out[part] = (out[part] || 0) + value;
  }
  return out;
}

function groupKeys(models, group) {
  const keys = [...CANONICAL_METRIC_KEYS[group]];
  for (const model of models) {
    for (const key of Object.keys(model?.[group] || {})) {
      if (!keys.includes(key) && key !== FINISH_REASON_ALIAS) keys.push(key);
    }
  }
  return keys;
}

// Histograms of one key merged over models; bounds that differ cannot be
// merged bucket by bucket and keep only their totals.
function mergeModelHistograms(models, key) {
  const list = models.map((model) => model?.histograms?.[key]).filter((hist) => hist && Array.isArray(hist.le));
  if (!list.length) return null;
  try {
    return list.reduce((merged, hist) => mergeHist(merged, hist), null);
  } catch {
    const count = list.reduce((total, hist) => total + (Number(hist.count) || 0), 0);
    const sum = list.every((hist) => typeof hist.sum === "number") ? list.reduce((total, hist) => total + hist.sum, 0) : null;
    return { le: ["+Inf"], counts: [count], sum, count };
  }
}

function summarizeHistogram(hist) {
  if (!hist) return null;
  const count = Number(hist.count) || 0;
  return {
    avg: count > 0 && typeof hist.sum === "number" ? hist.sum / count : null,
    p50: quantile(hist, 0.5),
    p95: quantile(hist, 0.95),
    count,
  };
}

/**
 * summarize(mapped, { previous? }) → the flat per-instance view (01 §16.1):
 * counters and gauges summed over models (ratio gauges take the maximum),
 * finish reasons summed per reason, histograms as {avg, p50, p95, count}.
 * Counters stay cumulative. With `previous` (an earlier mapPrometheus result
 * of the same process), histograms describe the interval through
 * deltaCumulative; after a reset, or without `previous`, they cover the time
 * since the process started. specAcceptRate falls back to accepted / draft
 * tokens when the engine has no gauge for it.
 */
function summarize(mapped, options = {}) {
  const models = Array.isArray(mapped?.models) ? mapped.models : [];
  const previousModels = Array.isArray(options.previous?.models) ? options.previous.models : null;
  const out = {};
  for (const key of groupKeys(models, "counters")) {
    let value = null;
    for (const model of models) {
      const item = model?.counters?.[key];
      if (item === null || item === undefined) continue;
      if (isPlainObject(item)) value = addSplit(isPlainObject(value) ? value : null, item);
      else if (typeof item === "number") value = (typeof value === "number" ? value : 0) + item;
    }
    out[key] = value;
  }
  for (const key of groupKeys(models, "gauges")) {
    let value = null;
    for (const model of models) {
      const item = model?.gauges?.[key];
      if (typeof item !== "number") continue;
      value = value === null ? item : isRatioKey(key) ? Math.max(value, item) : value + item;
    }
    out[key] = value;
  }
  for (const key of groupKeys(models, "histograms")) {
    const current = mergeModelHistograms(models, key);
    const interval = current && previousModels ? deltaCumulative(mergeModelHistograms(previousModels, key), current) : null;
    out[key] = summarizeHistogram(interval || current);
  }
  if (out.specAcceptRate === null && out.specDraftTokensTotal > 0 && typeof out.specAcceptedTokensTotal === "number") {
    out.specAcceptRate = out.specAcceptedTokensTotal / out.specDraftTokensTotal;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Instance sampler

function seconds(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value > 1e12 ? value / 1000 : value;
  }
  // docker ps prints "2026-10-14 08:00:00 +0800 CST"; the zone name is noise.
  const parsed = Date.parse(String(value).trim().replace(/\s+[A-Z]{2,6}$/i, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed / 1000 : null;
}

/** `${engineId}:${containerId first 6}:${processStartSeconds}` (01 §16.1). */
function runtimeKeyFor(engineId, containerId, processStartSeconds) {
  const id = String(containerId || "").replace(/^sha256:/, "").slice(0, 6) || "unknown";
  const start = typeof processStartSeconds === "number" && Number.isFinite(processStartSeconds) ? Math.floor(processStartSeconds) : "unknown";
  return `${engineId || UNKNOWN_ENGINE_ID}:${id}:${start}`;
}

function containerNameOf(container) {
  return String(container?.name || container?.Names || "").split(",")[0].trim().replace(/^\//, "");
}

function errorCodeForStatus(status) {
  // llama-server without --metrics answers 501; an engine without the route, 404.
  return status === 404 || status === 501 ? "unsupported_endpoint" : `http_${status}`;
}

function isTimeout(error) {
  return error?.name === "TimeoutError" || error?.name === "AbortError" || error?.code === "UND_ERR_HEADERS_TIMEOUT";
}

async function readTextCapped(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw metricsError("metrics_too_large", "The metrics response is too large.");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw metricsError("metrics_too_large", "The metrics response is too large.");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw metricsError("metrics_too_large", "The metrics response is too large.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runLimited(items, limit, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

function clone(value) {
  return value === null || value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/**
 * The GET /api/instances/:id/metrics body (01 §16.1) for one sampler entry.
 * Before the first scrape (and while the container is stopped) it reports
 * scrapeOk:false with errorCode "no_sample".
 */
function buildInstanceMetricsPayload(entry, managerId) {
  const sample = entry.sample || null;
  const processStartSeconds = sample?.processStartSeconds ?? entry.containerStartSeconds ?? null;
  return {
    ok: true,
    fleetId: `${managerId}:${entry.instanceId}`,
    managerId,
    instanceId: entry.instanceId,
    engineId: entry.engineId,
    runtimeId: entry.runtimeId,
    launchId: entry.launchId,
    runtimeKey: runtimeKeyFor(entry.engineId, entry.containerId, processStartSeconds),
    processStartSeconds,
    scrapedAt: sample?.scrapedAt ?? null,
    scrapeOk: Boolean(sample?.scrapeOk),
    errorCode: sample ? sample.errorCode : "no_sample",
    metrics: clone(sample?.metrics ?? null),
    raw: clone(sample?.raw ?? null),
    facts: clone(sample?.facts ?? {}),
    unsupported: [...(sample?.unsupported || [])],
  };
}

/**
 * createInstanceMetricsSampler(options) → { start, stop, tick, ready, resolve, read, list, stats }
 *
 * Scrapes every running instance of this manager every intervalMs (10 s), with
 * a timeout of timeoutMs (3 s) and at most `concurrency` (4) scrapes at once,
 * and keeps the latest snapshot per instance. read(id) serves that snapshot
 * and never scrapes or lists, so the metrics route costs no engine or Docker
 * call. Options:
 *
 *   registry, managerId ("vllm" | "llama"), ownerLabelValue (the ai.manager label value)
 *   primaryContainerName
 *   listContainers()        → container statuses ({name, id, running, image, createdAt, startedAt, labels}); Docker, background only
 *   endpointFor(container)  → { port } (default: label ai.manager.port)
 *   headersFor(container)   → request headers for the engine (API key)
 *   getDerivedInputs(inst)  → values for descriptor derive sources, or null
 *   getFacts(inst)          → facts returned as-is by the route, or null
 *   adapterFor(descriptor)  → adapter with mapMetrics, for format "json" engines
 *   fetchImpl, now, intervalMs, timeoutMs, concurrency, maxBytes
 *
 * Instances follow P0-RT-4's ownership rule (resolveLogContainer): the
 * primary container unless another manager owns it, and containers labelled
 * for this manager whose engine it hosts; the id is "primary", the
 * ai.manager.instance label or the container name, and the container name
 * resolves too.
 */
function createInstanceMetricsSampler(options = {}) {
  const registry = options.registry;
  if (!registry || typeof registry.hostedBy !== "function") throw new TypeError("createInstanceMetricsSampler needs an engine registry.");
  const managerId = normalizeManagerId(options.managerId);
  if (!managerId) throw new TypeError(`createInstanceMetricsSampler: unknown managerId ${options.managerId}`);
  if (typeof options.listContainers !== "function") throw new TypeError("createInstanceMetricsSampler needs listContainers().");
  const ownerLabelValue = String(options.ownerLabelValue || `${managerId}-manager`);
  const primaryContainerName = String(options.primaryContainerName || "");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const intervalMs = Math.max(1000, Number(options.intervalMs ?? DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
  const timeoutMs = Math.max(100, Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const concurrency = Math.max(1, Math.floor(Number(options.concurrency ?? DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY));
  const maxBytes = Math.max(1024, Number(options.maxBytes ?? MAX_METRICS_TEXT_BYTES) || MAX_METRICS_TEXT_BYTES);
  const endpointFor = typeof options.endpointFor === "function"
    ? options.endpointFor
    : (container) => ({ port: Number(container?.labels?.["ai.manager.port"] || 0) });
  const headersFor = typeof options.headersFor === "function" ? options.headersFor : () => ({});
  const adapterFor = typeof options.adapterFor === "function" ? options.adapterFor : () => null;

  let entries = new Map();
  let listedAt = null;
  let timer = null;
  let running = null;
  const counters = { ticks: 0, listings: 0, listErrors: 0, scrapes: 0 };

  function hosted() {
    return new Set(registry.hostedBy(managerId));
  }

  function engineIdFor(labels) {
    const labelled = labels["ai.manager.engine-id"];
    if (labelled && registry.has(labelled)) return labelled;
    return registry.fromLegacy(labels["ai.manager.engine"], managerId);
  }

  function runtimeIdFor(engineId, labels, image) {
    if (labels["ai.manager.runtime-id"]) return String(labels["ai.manager.runtime-id"]);
    if (!image) return null;
    if (registry.has(engineId)) {
      try {
        return registry.resolveRuntime(engineId, { image }).runtimeId || null;
      } catch {
        // Not a runtime of this engine: fall through to the manifest.
      }
    }
    return runtimeForImage(image)?.runtimeId || null;
  }

  function describe(container, hostedIds) {
    if (!container || container.exists === false) return null;
    const name = containerNameOf(container);
    if (!name) return null;
    const labels = isPlainObject(container.labels) ? container.labels : {};
    const owner = String(labels["ai.manager"] || container.manager || "");
    const primary = Boolean(primaryContainerName) && name === primaryContainerName;
    if (primary ? owner && owner !== ownerLabelValue : owner !== ownerLabelValue) return null;
    const engineId = engineIdFor(labels);
    if (!primary && !hostedIds.has(engineId)) return null;
    const image = String(container.image || "");
    const containerId = String(container.id || container.ID || "");
    const createdAt = container.createdAt || container.CreatedAt || "";
    return {
      instanceId: primary ? "primary" : String(labels["ai.manager.instance"] || name),
      containerName: name,
      containerId,
      primary,
      running: Boolean(container.running),
      engineId,
      image,
      launchId: labels["ai.manager.launch-id"] ? String(labels["ai.manager.launch-id"]) : null,
      model: String(labels["ai.manager.model"] || ""),
      containerStartSeconds: seconds(container.startedAt) ?? seconds(createdAt),
      identity: [containerId, createdAt, name, image].join("|"),
      container,
      labels,
    };
  }

  async function list() {
    counters.listings += 1;
    const containers = await options.listContainers();
    const hostedIds = hosted();
    const next = new Map();
    for (const container of Array.isArray(containers) ? containers : []) {
      const instance = describe(container, hostedIds);
      if (!instance || next.has(instance.instanceId)) continue;
      const previous = entries.get(instance.instanceId);
      const same = previous && previous.identity === instance.identity;
      next.set(instance.instanceId, {
        ...instance,
        runtimeId: same ? previous.runtimeId : runtimeIdFor(instance.engineId, instance.labels, instance.image),
        // A replaced or stopped container's last scrape describes another process.
        sample: same && instance.running ? previous.sample : null,
      });
    }
    entries = next;
    listedAt = now();
  }

  function store(entry, sample) {
    const current = entries.get(entry.instanceId);
    if (current && current.identity === entry.identity) current.sample = sample;
  }

  async function scrape(entry) {
    const scrapedAt = new Date(now()).toISOString();
    const fail = (errorCode) => store(entry, {
      scrapedAt,
      scrapeOk: false,
      errorCode,
      processStartSeconds: null,
      metrics: null,
      raw: null,
      facts: {},
      unsupported: [],
    });
    const descriptor = registry.has(entry.engineId) ? registry.get(entry.engineId) : null;
    const metricsMap = descriptor?.metricsMap;
    const adapter = descriptor ? adapterFor(descriptor) : null;
    const jsonFormat = metricsMap?.format === "json";
    if (!metricsMap?.path || (jsonFormat && typeof adapter?.mapMetrics !== "function")) return fail("unsupported_endpoint");

    let response;
    let text;
    try {
      const endpoint = await endpointFor(entry.container);
      const port = Number(typeof endpoint === "number" ? endpoint : endpoint?.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return fail("unreachable");
      const headers = await headersFor(entry.container);
      counters.scrapes += 1;
      response = await fetchImpl(`http://127.0.0.1:${port}${metricsMap.path}`, {
        headers: isPlainObject(headers) ? headers : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        return fail(errorCodeForStatus(response.status));
      }
      text = await readTextCapped(response, maxBytes);
    } catch (error) {
      if (error?.code === "metrics_too_large") return fail("parse_error");
      return fail(isTimeout(error) ? "timeout" : "unreachable");
    }

    let derived = null;
    let facts = {};
    try {
      derived = typeof options.getDerivedInputs === "function" ? await options.getDerivedInputs(entry) : null;
    } catch {
      derived = null;
    }
    try {
      const value = typeof options.getFacts === "function" ? await options.getFacts(entry) : null;
      facts = isPlainObject(value) ? value : {};
    } catch {
      facts = {};
    }

    let mapped;
    try {
      if (jsonFormat) {
        mapped = adapter.mapMetrics(JSON.parse(text), { descriptor, derived, defaultModel: entry.model });
      } else {
        mapped = mapPrometheus(entry.engineId, parsePrometheus(text), { descriptor, derived, defaultModel: entry.model });
      }
      if (!mapped || !Array.isArray(mapped.models)) throw metricsError("parse_error", "The adapter returned no models.");
    } catch {
      return fail("parse_error");
    }
    const processStartSeconds = typeof mapped.processStartSeconds === "number" ? mapped.processStartSeconds : null;
    store(entry, {
      scrapedAt,
      scrapeOk: true,
      errorCode: null,
      processStartSeconds: processStartSeconds ?? entry.containerStartSeconds ?? null,
      metrics: summarize(mapped),
      raw: { processStartSeconds, models: mapped.models },
      facts,
      unsupported: Array.isArray(mapped.unsupported) ? mapped.unsupported : [],
    });
    return undefined;
  }

  async function runTick() {
    counters.ticks += 1;
    try {
      await list();
    } catch {
      // Docker did not answer: keep the last listing and scrape what it knew.
      counters.listErrors += 1;
    }
    const targets = [...entries.values()].filter((entry) => entry.running);
    await runLimited(targets, concurrency, (entry) => scrape(entry).catch(() => {}));
  }

  /** One listing plus one scrape round; concurrent calls share the round in flight. */
  function tick() {
    if (!running) {
      running = runTick().finally(() => {
        running = null;
      });
    }
    return running;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch(() => {});
    }, intervalMs);
    timer.unref?.();
    tick().catch(() => {});
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** id ("primary", an instance id or a container name) → entry, or null. Never lists or scrapes. */
  function resolve(id) {
    const requested = typeof id === "string" ? id.trim() : "";
    if (!requested || requested.length > MAX_INSTANCE_ID_LENGTH) return null;
    if (entries.has(requested)) return entries.get(requested);
    for (const entry of entries.values()) {
      if (entry.containerName === requested) return entry;
    }
    return null;
  }

  function read(id) {
    const entry = resolve(id);
    return entry ? buildInstanceMetricsPayload(entry, managerId) : null;
  }

  return {
    managerId,
    intervalMs,
    start,
    stop,
    tick,
    /** Whether a listing has completed, so an id that is not found is unknown. */
    ready: () => listedAt !== null,
    resolve,
    read,
    list: () => [...entries.values()].map((entry) => buildInstanceMetricsPayload(entry, managerId)),
    stats: () => ({ ...counters, listedAt: listedAt === null ? null : new Date(listedAt).toISOString(), instances: entries.size, running: Boolean(timer) }),
  };
}

module.exports = {
  CANONICAL_METRIC_KEYS,
  ERROR_CODES,
  MAX_METRICS_TEXT_BYTES,
  buildInstanceMetricsPayload,
  createInstanceMetricsSampler,
  deltaCumulative,
  evaluateDerive,
  mapPrometheus,
  parsePrometheus,
  quantile,
  runtimeKeyFor,
  summarize,
};
