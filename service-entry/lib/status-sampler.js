"use strict";

// Public status, catalog and announcements (05 §12.2, §12.3, §12.7; PUB-14).
//
// startStatusSampler() samples the fleet once a minute into the store's
// status_samples table (30 days, pruned daily) and serves the cached
// /status.json document. createPublicData() builds the four JSON documents
// public-listener.js serves: /status.json, /catalog.json, /announcements.json
// and /portal-config.json.
//
// Nothing here may leak internals: ports, paths, manager ids, instance ids,
// container names and engine names never reach a document. Documents are
// built from an allowlist of fields, never by copying a catalog entry.

const {
  inferModelCapabilities,
  isLastKnownModel,
  hasOnlyLastKnownModels,
  isRoutableInstance,
  normalizeInstanceLifecycleState,
} = require("./model-fleet");
const { modelAllowed } = require("./key-policy");

const SCHEMA_VERSION = 1;
const SAMPLE_INTERVAL_MS = 60_000;
const STATUS_CACHE_MS = 15_000;
const RETENTION_MS = 30 * 24 * 3600_000;
const PRUNE_EVERY_MS = 24 * 3600_000;
const ERROR_WINDOW_MS = 5 * 60_000;
const PERF_WINDOW_MS = 15 * 60_000;
const ERROR_RATE_LIMIT = 0.05;
// Fewer requests than this in the window say nothing about a rate.
const ERROR_RATE_MIN_REQUESTS = 5;
const MINUTE_MS = 60_000;
const HOUR_MS = 3600_000;

const OVERALL = Object.freeze(["operational", "degraded", "offline", "maintenance"]);
const MESSAGES = Object.freeze({
  operational: { "zh-CN": "服务正常", "en-US": "All systems operational" },
  degraded: { "zh-CN": "部分服务降级", "en-US": "Some systems are degraded" },
  offline: { "zh-CN": "主机离线", "en-US": "The host is offline" },
  maintenance: { "zh-CN": "维护中", "en-US": "Scheduled maintenance" },
});
const STATE_RANK = Object.freeze({ ready: 3, loading: 2, degraded: 1, offline: 0 });
// A model id that is a file system path is an internal, never a public name.
const PATH_LIKE_ID = /^(?:[A-Za-z]:[\\/]|\/|\\|\.{1,2}[\\/])/;

function round(value, step) {
  return Math.round(value / step) * step;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nowMs(now) {
  const value = typeof now === "function" ? now() : Date.now();
  return value instanceof Date ? value.getTime() : Number(value);
}

function isoSeconds(ms) {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function minuteOf(ms) {
  return new Date(ms).toISOString().slice(0, 16);
}

function minuteToMs(minute) {
  return Date.parse(`${minute}:00Z`);
}

function readConfig(config) {
  const value = typeof config === "function" ? config() : config && typeof config.get === "function" ? config.get() : config;
  return value && typeof value === "object" ? value : {};
}

function publishPatterns(config) {
  const list = readConfig(config).public?.catalog?.publish;
  return Array.isArray(list) && list.length ? list : ["*"];
}

function publicId(id) {
  const text = String(id ?? "").trim();
  return text && !PATH_LIKE_ID.test(text) ? text : "";
}

// ---- fleet reading -------------------------------------------------------

function instanceState(instance) {
  if (isRoutableInstance(instance)) return "ready";
  const running = instance?.running === true;
  const lifecycle = normalizeInstanceLifecycleState(instance, running, instance?.status || "");
  if (running && hasOnlyLastKnownModels(instance)) return "loading";
  if (lifecycle === "ready") return "loading";
  if (lifecycle === "loading") return "loading";
  if (lifecycle === "degraded") return "degraded";
  return "offline";
}

// Every distinct model id in the catalogs with its best state and the fields
// the public documents may show. The result carries no engine, manager,
// instance, container, port or path.
function collectFleetModels(catalogs) {
  const byId = new Map();
  const take = (source, state, instance) => {
    const model = typeof source === "string" ? { id: source } : (source && typeof source === "object" ? source : null);
    if (!model) return;
    const id = publicId(model.id);
    if (!id) return;
    const entry = byId.get(id.toLowerCase());
    const waiting = Number(instance?.waiting ?? instance?.stats?.waiting ?? model.waiting);
    const running = Number(instance?.runningRequests ?? instance?.stats?.running ?? model.running_requests);
    const fresh = {
      id,
      state,
      source: model,
      waiting: Number.isFinite(waiting) ? waiting : null,
      running: Number.isFinite(running) ? running : null,
    };
    if (!entry || STATE_RANK[state] > STATE_RANK[entry.state]) byId.set(id.toLowerCase(), fresh);
  };
  for (const catalog of Array.isArray(catalogs) ? catalogs : []) {
    if (!catalog || typeof catalog !== "object") continue;
    if (Array.isArray(catalog.instances) && catalog.instances.length) {
      for (const instance of catalog.instances) {
        const state = catalog.running === false && instance?.running !== true ? "offline" : instanceState(instance);
        for (const model of Array.isArray(instance?.models) ? instance.models : []) {
          // A remembered model of a stopped instance is listed as offline.
          take(model, isLastKnownModel(model) && state === "ready" ? "loading" : state, instance);
        }
      }
    } else if (Array.isArray(catalog.models)) {
      const state = catalog.running === false ? "offline" : "ready";
      for (const model of catalog.models) take(model, state, catalog);
    }
  }
  return [...byId.values()];
}

function publishedModels(catalogs, { config, store } = {}) {
  const patterns = publishPatterns(config);
  const metaList = store?.modelMeta?.list ? store.modelMeta.list() : (typeof store?.listModelMeta === "function" ? store.listModelMeta() : []);
  const metaById = new Map(metaList.map((meta) => [String(meta.modelId).toLowerCase(), meta]));
  const hiddenIds = new Set(metaList.filter((meta) => meta.hidden).map((meta) => String(meta.modelId).toLowerCase()));
  const hiddenByAlias = new Set();
  for (const meta of metaList) {
    if (meta.hidden) for (const alias of meta.aliases || []) hiddenByAlias.add(String(alias).toLowerCase());
  }
  const out = [];
  for (const item of collectFleetModels(catalogs)) {
    const lower = item.id.toLowerCase();
    if (hiddenIds.has(lower) || hiddenByAlias.has(lower)) continue;
    if (!modelAllowed({ models: patterns }, { id: item.id, aliases: item.source.aliases })) continue;
    out.push({ ...item, meta: metaById.get(lower) || null });
  }
  out.sort((a, b) => (a.meta?.sort ?? 0) - (b.meta?.sort ?? 0) || a.id.localeCompare(b.id));
  return out;
}

function displayNames(item) {
  const meta = item.meta;
  const zh = meta?.displayName?.zh || meta?.displayName?.en || item.id;
  const en = meta?.displayName?.en || meta?.displayName?.zh || item.id;
  return { "zh-CN": zh, "en-US": en };
}

// ---- announcements -------------------------------------------------------

function listAnnouncementRows(store, query) {
  if (!store) return [];
  const list = store.announcements?.list || store.listAnnouncements;
  return typeof list === "function" ? list(query) : [];
}

function announcementView(row, { body = false, at } = {}) {
  const view = {
    id: row.id,
    severity: row.severity,
    title: { "zh-CN": row.title.zh, "en-US": row.title.en },
    starts_at: row.startsAt,
    ends_at: row.endsAt ?? null,
  };
  if (body) {
    view.body = { "zh-CN": row.body.zh, "en-US": row.body.en };
    view.active = Date.parse(row.startsAt) <= at && (!row.endsAt || Date.parse(row.endsAt) > at);
  }
  return view;
}

// Published announcements for everyone. active: running now; withUpcoming adds
// those that start later. Sorted by start, newest first (the store's order).
function publicAnnouncements(store, at, { withUpcoming = false } = {}) {
  const rows = listAnnouncementRows(store, { published: true, audience: "all", limit: 100 });
  return rows.filter((row) => {
    const starts = Date.parse(row.startsAt);
    const ends = row.endsAt ? Date.parse(row.endsAt) : Infinity;
    if (ends <= at) return false;
    return withUpcoming ? true : starts <= at;
  });
}

// ---- overall state -------------------------------------------------------

/**
 * The §12.2 rules, pure. Order: maintenance, offline, degraded, operational.
 *   models           [{ state }] published, visible models
 *   announcements    active published announcements ({ severity })
 *   errorRate        5xx share over 5 min, or null without telemetry
 *   requests         requests behind errorRate
 *   shareQueue       { queued, max } or null
 */
function computeOverall({ models = [], announcements = [], errorRate = null, requests = 0, shareQueue = null } = {}) {
  if (announcements.some((item) => item.severity === "maintenance")) return "maintenance";
  if (!models.some((model) => model.state === "ready")) return "offline";
  if (models.some((model) => model.state !== "ready")) return "degraded";
  if (errorRate !== null && requests >= ERROR_RATE_MIN_REQUESTS && errorRate > ERROR_RATE_LIMIT) return "degraded";
  if (shareQueue && shareQueue.max > 0 && shareQueue.queued * 2 >= shareQueue.max) return "degraded";
  return "operational";
}

function queueBucket(item, stats) {
  const waiting = item.waiting ?? Number(stats?.waiting);
  const running = item.running ?? Number(stats?.running);
  if (Number.isFinite(waiting) && waiting > 0) return "busy";
  if (Number.isFinite(running) && running > 0) return "light";
  return "idle";
}

// ---- uptime --------------------------------------------------------------

function uptimeOf(samples, windowMs, at) {
  if (!samples.length) return null;
  const nowMinute = minuteOf(at);
  const startMs = Math.max(at - windowMs, minuteToMs(samples[0].minute));
  let up = 0;
  let maintenance = 0;
  let counted = 0;
  const seen = new Set();
  for (const sample of samples) {
    const ms = minuteToMs(sample.minute);
    if (ms < startMs - MINUTE_MS || seen.has(sample.minute)) continue;
    seen.add(sample.minute);
    if (sample.overall === "maintenance") maintenance += 1;
    else if (sample.overall === "operational" || sample.overall === "degraded") up += 1;
    counted += 1;
  }
  // Minutes with no sample count as down (the entry itself was not running),
  // except the minute in progress.
  const first = minuteOf(startMs);
  const slots = Math.max(0, Math.round((minuteToMs(nowMinute) - minuteToMs(first)) / MINUTE_MS) + (seen.has(nowMinute) ? 1 : 0));
  const denominator = Math.max(slots, counted) - maintenance;
  if (denominator <= 0) return null;
  return Math.min(100, round1((up / denominator) * 100));
}

function hourlyUptime(samples, at, hours = 168) {
  const currentHour = Math.floor(at / HOUR_MS) * HOUR_MS;
  const buckets = new Map();
  for (const sample of samples) {
    const hour = Math.floor(minuteToMs(sample.minute) / HOUR_MS) * HOUR_MS;
    const bucket = buckets.get(hour) || { total: 0, up: 0 };
    bucket.total += 1;
    if (sample.overall !== "offline") bucket.up += 1;
    buckets.set(hour, bucket);
  }
  const out = [];
  for (let index = hours - 1; index >= 0; index -= 1) {
    const hour = currentHour - index * HOUR_MS;
    const bucket = buckets.get(hour);
    out.push({
      hour: isoSeconds(hour),
      up: bucket ? (bucket.up * 2 >= bucket.total ? 1 : 0) : null,
    });
  }
  return out;
}

// ---- the sampler ---------------------------------------------------------

async function readTelemetry(telemetry) {
  const read = telemetry && telemetry.statusStats;
  if (typeof read !== "function") return null;
  try {
    const stats = await read.call(telemetry, { errorWindowMs: ERROR_WINDOW_MS, perfWindowMs: PERF_WINDOW_MS });
    return stats && typeof stats === "object" ? stats : null;
  } catch {
    return null;
  }
}

function telemetryModelStats(stats, id) {
  const models = stats?.models;
  if (!models || typeof models !== "object") return null;
  return models[id] || models[id.toLowerCase()] || null;
}

/**
 * startStatusSampler({ getCatalogs, telemetry, store, config, intervalMs, shareQueue, now })
 *   getCatalogs()  -> fleet catalogs (the shape model-fleet.catalogCandidates reads)
 *   telemetry      optional; statusStats({errorWindowMs, perfWindowMs}) ->
 *                  { requests, errors5xx, models: { [id]: { ttftP50Ms, tokensPerSecond, waiting?, running? } } }
 *   store          keys-store (announcements, modelMeta, putSample, listSamples, pruneSamples)
 *   config         AccessConfig, its source ({get()}) or a function returning it
 *   shareQueue()   optional -> { queued, max } of the public share queue
 *   now()          optional clock (ms)
 * -> { sampleNow(), getStatus(), stop(), pruneNow() }
 */
function startStatusSampler({ getCatalogs, telemetry = null, store, config, intervalMs = SAMPLE_INTERVAL_MS, shareQueue = null, now = Date.now, logger = null, autoStart = true } = {}) {
  if (typeof getCatalogs !== "function") throw new TypeError("startStatusSampler needs getCatalogs().");
  if (!store || typeof store.putSample !== "function") throw new TypeError("startStatusSampler needs the store (putSample).");
  let cache = null;
  let pending = null;
  let timer = null;
  let stopped = false;
  let lastPrune = 0;

  async function compute(at) {
    let catalogs = [];
    try {
      catalogs = await getCatalogs();
    } catch (error) {
      logger?.warn?.(`status sampler: catalogs unavailable (${error?.code || "error"}).`);
    }
    const stats = await readTelemetry(telemetry);
    const models = publishedModels(catalogs, { config, store });
    const active = publicAnnouncements(store, at);
    const requests = Number(stats?.requests ?? 0);
    const errors = Number(stats?.errors5xx ?? 0);
    const errorRate = stats && requests > 0 ? errors / requests : null;
    let queue = null;
    try {
      queue = typeof shareQueue === "function" ? shareQueue() : null;
    } catch {
      queue = null;
    }
    if (queue) {
      const max = Number(queue.max);
      queue = Number.isFinite(max) && Number.isFinite(Number(queue.queued)) ? { queued: Number(queue.queued), max } : null;
    }
    const overall = computeOverall({ models, announcements: active, errorRate, requests, shareQueue: queue });
    return { at, overall, models, active, stats };
  }

  function document(snapshot, samples) {
    const { at, overall, models, active, stats } = snapshot;
    const list = models.map((item) => {
      const perf = telemetryModelStats(stats, item.id);
      const entry = {
        id: item.id,
        display_name: displayNames(item)["en-US"],
        state: item.state,
        queue: queueBucket(item, perf),
      };
      const ttft = positive(perf?.ttftP50Ms);
      const tps = positive(perf?.tokensPerSecond);
      if (ttft !== null) entry.ttft_p50_ms = Math.max(50, round(ttft, 50));
      if (tps !== null) entry.tokens_per_second = Math.max(5, round(tps, 5));
      return entry;
    });
    const window24 = samples.filter((sample) => minuteToMs(sample.minute) >= at - 24 * HOUR_MS);
    return {
      schemaVersion: SCHEMA_VERSION,
      status: overall,
      updated_at: isoSeconds(at),
      message: { ...MESSAGES[overall] },
      models: list,
      uptime: {
        h24: uptimeOf(window24, 24 * HOUR_MS, at),
        d7: uptimeOf(samples, 7 * 24 * HOUR_MS, at),
        hours_7d: hourlyUptime(samples, at),
      },
      announcements: active.map((row) => announcementView(row)),
    };
  }

  function recentSamples(at) {
    try {
      return store.listSamples(minuteOf(at - 7 * 24 * HOUR_MS));
    } catch {
      return [];
    }
  }

  async function build(at) {
    const snapshot = await compute(at);
    return { snapshot, doc: document(snapshot, recentSamples(at)) };
  }

  async function sampleNow() {
    const at = nowMs(now);
    const { snapshot, doc } = await build(at);
    store.putSample(minuteOf(at), {
      overall: snapshot.overall,
      models: Object.fromEntries(snapshot.models.map((item) => [item.id, item.state])),
    });
    cache = { at, doc };
    if (at - lastPrune >= PRUNE_EVERY_MS) pruneNow();
    return doc;
  }

  function pruneNow() {
    const at = nowMs(now);
    lastPrune = at;
    try {
      return store.pruneSamples(minuteOf(at - RETENTION_MS));
    } catch (error) {
      logger?.warn?.(`status sampler: prune failed (${error?.code || "error"}).`);
      return 0;
    }
  }

  // The document served as /status.json: built at most once per 15 s.
  async function getStatus() {
    const at = nowMs(now);
    if (cache && at >= cache.at && at - cache.at < STATUS_CACHE_MS) return cache.doc;
    if (!pending) {
      pending = build(at)
        .then(({ doc }) => {
          cache = { at, doc };
          return doc;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  if (autoStart) {
    const tick = () => {
      if (stopped) return;
      sampleNow().catch((error) => logger?.warn?.(`status sampler: sample failed (${error?.code || "error"}).`));
    };
    tick();
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  }

  return { sampleNow, getStatus, stop, pruneNow };
}

// ---- catalog -------------------------------------------------------------

const QUANT_RE = /(nvfp4|mxfp4|fp8|fp16|bf16|awq|gptq|int4|int8|gguf|q[2-8]_[a-z0-9_]+)/i;

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function formatParameters(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  if (number >= 1e9) return `${round1(number / 1e9)}B`.replace(/\.0B$/, "B");
  if (number >= 1e6) return `${round1(number / 1e6)}M`.replace(/\.0M$/, "M");
  return null;
}

function modelFacts(item) {
  const model = item.source || {};
  const id = item.id;
  const capabilities = (() => {
    try {
      return inferModelCapabilities(model);
    } catch {
      return [];
    }
  })();
  const modalities = capabilities.filter((name) => ["text", "vision", "audio", "embedding", "rerank"].includes(name));
  const paramsRaw = model.parameters ?? model.params ?? model.parameter_count;
  const parameters = typeof paramsRaw === "number" ? formatParameters(paramsRaw)
    : firstText(paramsRaw) || (id.match(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z])/i)?.[1] ? `${id.match(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z])/i)[1]}B` : null);
  const quantization = firstText(model.quantization, model.quant) || id.match(QUANT_RE)?.[1]?.toUpperCase() || null;
  const family = firstText(model.family) || id.split("/").pop().match(/^[A-Za-z]+\d*/)?.[0]?.toLowerCase() || null;
  const context = positive(model.max_model_len ?? model.context_length ?? model.context_window ?? model.n_ctx);
  const maxOutput = positive(model.max_output_tokens ?? model.max_tokens);
  const reasoning = model.reasoning === true || capabilities.includes("reasoning") || /thinking|reason|(?:^|[^a-z])r1(?:[^a-z0-9]|$)|qwq/i.test(id);
  return {
    family,
    parameters,
    quantization,
    modalities: modalities.length ? modalities : ["text"],
    tools: model.tools === true || capabilities.includes("tools"),
    reasoning,
    context: context === null ? null : Math.floor(context),
    maxOutput: maxOutput === null ? null : Math.floor(maxOutput),
  };
}

function buildCatalogDocument({ catalogs, store, config, getPrices = null, at }) {
  const cfg = readConfig(config);
  const showPrices = cfg.public?.catalog?.showPrices !== false;
  const defaults = cfg.public?.defaults || {};
  const items = publishedModels(catalogs, { config, store });
  const models = items.map((item) => {
    const facts = modelFacts(item);
    const names = displayNames(item);
    const meta = item.meta;
    const entry = {
      id: item.id,
      display_name: names,
      description: { "zh-CN": meta?.description?.zh || "", "en-US": meta?.description?.en || "" },
      family: facts.family,
      parameters: facts.parameters,
      quantization: facts.quantization,
      modalities: facts.modalities,
      tools: facts.tools,
      reasoning: facts.reasoning,
      context: facts.context,
      max_output: facts.maxOutput ?? (positive(defaults.maxOutputTokens) ? Number(defaults.maxOutputTokens) : null),
      limits: {
        rpm: defaults.rpm ?? null,
        tpm: defaults.tpm ?? null,
        concurrency: defaults.maxConcurrent ?? null,
        max_output_tokens: defaults.maxOutputTokens ?? null,
      },
      recommended: meta?.recommended === true,
      aliases: Array.isArray(meta?.aliases) ? meta.aliases.slice(0, 20) : [],
      state: item.state,
    };
    if (showPrices && typeof getPrices === "function") {
      let price = null;
      try {
        price = getPrices(item.id);
      } catch {
        price = null;
      }
      if (price && typeof price === "object") entry.prices = price;
    }
    return entry;
  });
  return { schemaVersion: SCHEMA_VERSION, updated_at: isoSeconds(at), models };
}

function buildAnnouncementsDocument({ store, at }) {
  const rows = publicAnnouncements(store, at, { withUpcoming: true });
  return { schemaVersion: SCHEMA_VERSION, updated_at: isoSeconds(at), announcements: rows.map((row) => announcementView(row, { body: true, at })) };
}

function requestBase(req, cfg) {
  const configured = String(cfg.listeners?.public?.baseUrl || "").replace(/\/+$/, "");
  if (configured) return configured;
  // LAN-only: the allowed Host of this request. The listener already refused
  // names outside its allowlist.
  const host = String(req?.headers?.host || "").trim();
  if (!host || /[\s/\\@]/.test(host)) return "";
  return `${req?.socket?.encrypted ? "https" : "http"}://${host}`;
}

function buildPortalConfig({ req, config, getBuildId }) {
  const cfg = readConfig(config);
  const base = requestBase(req, cfg);
  let buildId = "";
  let commit = "";
  try {
    const build = typeof getBuildId === "function" ? getBuildId() : null;
    buildId = String(build?.contentHash || "");
    // The footer shows the commit (05 §12.1); present only when the build has one.
    commit = typeof build?.commit === "string" && /^[0-9a-f]{7,64}$/.test(build.commit) ? build.commit.slice(0, 12) : "";
  } catch {
    buildId = "";
  }
  return {
    baseUrl: base,
    openaiBase: base ? `${base}/v1` : "",
    anthropicBase: base ? `${base}/anthropic` : "",
    brand: {
      "zh-CN": cfg.public?.brand?.["zh-CN"] || "本地模型服务",
      "en-US": cfg.public?.brand?.["en-US"] || "Local Model Service",
    },
    buildId,
    ...(commit ? { commit } : {}),
    features: {
      playground: true,
      showPrices: cfg.public?.catalog?.showPrices !== false,
      tts: cfg.public?.exposeTts !== false,
    },
  };
}

/**
 * createPublicData({ sampler, getCatalogs, store, config, getBuildId, getPrices, now })
 * -> { respond(pathname, req) -> Promise<object|null> }
 * Serves the four portal JSON documents; null for any other path.
 * /catalog.json is cached 15 s like /status.json.
 */
function createPublicData({ sampler, getCatalogs, store, config, getBuildId = null, getPrices = null, now = Date.now } = {}) {
  let catalogCache = null;
  let catalogPending = null;

  async function catalog() {
    const at = nowMs(now);
    if (catalogCache && at >= catalogCache.at && at - catalogCache.at < STATUS_CACHE_MS) return catalogCache.doc;
    if (!catalogPending) {
      catalogPending = Promise.resolve()
        .then(() => getCatalogs())
        .then((catalogs) => {
          const doc = buildCatalogDocument({ catalogs, store, config, getPrices, at });
          catalogCache = { at, doc };
          return doc;
        })
        .finally(() => {
          catalogPending = null;
        });
    }
    return catalogPending;
  }

  return {
    async respond(pathname, req) {
      switch (pathname) {
        case "/status.json":
          return sampler.getStatus();
        case "/catalog.json":
          return catalog();
        case "/announcements.json":
          return buildAnnouncementsDocument({ store, at: nowMs(now) });
        case "/portal-config.json":
          return buildPortalConfig({ req, config, getBuildId });
        default:
          return null;
      }
    },
  };
}

module.exports = {
  ERROR_RATE_LIMIT,
  OVERALL,
  PERF_WINDOW_MS,
  RETENTION_MS,
  STATUS_CACHE_MS,
  buildAnnouncementsDocument,
  buildCatalogDocument,
  buildPortalConfig,
  collectFleetModels,
  computeOverall,
  createPublicData,
  displayNames,
  instanceState,
  modelFacts,
  publicAnnouncements,
  publicId,
  publishedModels,
  startStatusSampler,
};
