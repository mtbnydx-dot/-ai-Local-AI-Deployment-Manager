"use strict";

// Manager routes for the engine registry (docs/overhaul/01-engines.md §21.1):
//   GET  /api/engines                      hosted engines, runtimes, health
//   POST /api/engines/descriptors/validate side-effect-free draft validation
//   GET  /api/engines/:engineId/schema     parameter catalog + availability + facts + recipes
//   GET  /api/instances/:id/metrics        latest sampler snapshot (01 §16.1)
//   POST /api/recipes/reload               re-read config/recipes (01 §10.3)
//   GET  /api/instances/:id/logs           one instance's redacted log tail (ENG-13)
//   GET  /api/instances/:id/launch         its LaunchStore record and redacted command
//   POST /api/instances/:id/relaunch       start it again from that record (confirm:true)
//   POST /api/runtimes/:runtimeId/pull     explicit image pull as a dl_ job (01 §14, §21.1)
// Later packages (launch plan) add their routes here too.
// Docker is touched only through the injected getImageStatus/listManagedContainers
// reads, both cached, so a dashboard polling this route stays cheap. The metrics
// route reads the background sampler only: no engine scrape and no Docker call.

const { isPlainObject } = require("./descriptor-schema");
const { buildFacts, buildSchemaPayload, getParamCatalog, hostFactsFromGpus } = require("./param-catalog");
const { matchRecipes } = require("./recipes");
const { redactSecrets } = require("../secret-redactor");
const { normalizeManagerId } = require("./registry");
const { sendJsonError } = require("../runtime-routes");
const { publicPlan } = require("./resolve-launch-plan");
const { createRuntimeFacts } = require("./runtime-facts");
const { summarizeJob } = require("../job-routes");
const { buildIntrospectionCommand, introspectRuntime, diffFlagSets, refineAutoParsers } = require("./introspect");

const MAX_DRAFT_BYTES = 256 * 1024;
const IMAGE_PRESENCE_TTL_MS = 60_000;
// "Docker is down" is re-checked sooner than a known present/missing answer.
const IMAGE_UNKNOWN_TTL_MS = 5_000;
const INSTANCE_COUNT_TTL_MS = 10_000;
const ENGINE_ID_LABEL_KEY = "ai.manager.engine-id";
const LEGACY_ENGINE_LABEL_KEY = "ai.manager.engine";
const INSTANCE_MODES = Object.freeze(["replace", "parallel", "add"]);
const MAX_QUERY_TEXT = 1024;
const DEFAULT_LOG_TAIL = 200;
const MAX_LOG_TAIL = 5000;
// Same shape the managers accept for an instance id (runtime-request-utils).
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
const RELAUNCH_LAUNCH_ID_WAIT_MS = 2000;

// 00 §4.2 error envelope for the new admin JSON APIs.
function errorEnvelope(code, message, hint) {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } };
}

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function httpError(status, code, message, hint) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (hint) error.hint = hint;
  return error;
}

// One query value as trimmed text (Express gives arrays for repeated keys).
function queryText(value) {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim().slice(0, MAX_QUERY_TEXT) : "";
}

/**
 * present(image) → true | false | null. null means Docker could not answer
 * (daemon down, timeout), never "missing". Answers are cached per image.
 */
function createImagePresenceProbe(options = {}) {
  const getImageStatus = options.getImageStatus;
  const ttlMs = Math.max(0, Number(options.ttlMs ?? IMAGE_PRESENCE_TTL_MS));
  const unknownTtlMs = Math.max(0, Number(options.unknownTtlMs ?? IMAGE_UNKNOWN_TTL_MS));
  const now = typeof options.now === "function" ? options.now : Date.now;
  const entries = new Map();

  async function inspect(image) {
    try {
      const status = await getImageStatus(image);
      if (status?.ok) return { value: true, imageId: status.id || null };
      if (status?.reason === "missing-image") return { value: false, imageId: null };
      return { value: null, imageId: null };
    } catch {
      return { value: null, imageId: null };
    }
  }

  function present(image) {
    const key = String(image || "").trim();
    if (!key || typeof getImageStatus !== "function") return Promise.resolve(null);
    const cached = entries.get(key);
    if (cached?.promise) return cached.promise;
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value);
    const promise = inspect(key).then((answer) => {
      entries.set(key, { ...answer, expiresAt: now() + (answer.value === null ? unknownTtlMs : ttlMs) });
      return answer.value;
    });
    entries.set(key, { ...(cached || {}), promise });
    return promise;
  }

  async function imageId(image, { force = false } = {}) {
    if (force) entries.delete(image);
    await present(image);
    return entries.get(image)?.imageId || null;
  }

  return { present, imageId, clear: () => entries.clear() };
}

/**
 * The runtime ref a manager can pull: runtimeId among the runtimes of the
 * engines it hosts (env image overrides applied). Throws 404 unknown_runtime.
 */
function findHostedRuntime(registry, managerId, runtimeId) {
  const id = String(runtimeId ?? "").trim();
  const host = normalizeManagerId(managerId);
  if (id) {
    for (const engineId of registry.hostedBy(host)) {
      const ref = registry.runtimesFor(engineId).find((item) => item.runtimeId === id);
      if (ref) return { ...ref, engineId: ref.engineId || engineId };
    }
  }
  throw httpError(404, "unknown_runtime", `Unknown runtime for this manager: ${id || "(none)"}.`);
}

/** counts() → { [engineId]: runningContainers } for this manager, or null when unknown. */
function createInstanceCounter(options = {}) {
  const { listManagedContainers, ownerLabelValue, registry } = options;
  const managerId = normalizeManagerId(options.managerId);
  const ttlMs = Math.max(0, Number(options.ttlMs ?? INSTANCE_COUNT_TTL_MS));
  const now = typeof options.now === "function" ? options.now : Date.now;
  let cached = null;
  let inFlight = null;

  function engineOf(container) {
    const labelled = container.labels?.[ENGINE_ID_LABEL_KEY];
    if (labelled && registry.has(labelled)) return labelled;
    return registry.fromLegacy(container.engine ?? container.labels?.[LEGACY_ENGINE_LABEL_KEY], managerId);
  }

  function counts() {
    if (typeof listManagedContainers !== "function") return Promise.resolve(null);
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value);
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(() => listManagedContainers())
      .then((containers) => {
        const value = {};
        for (const container of Array.isArray(containers) ? containers : []) {
          if (!container?.running) continue;
          if (ownerLabelValue && container.manager !== ownerLabelValue) continue;
          const engineId = engineOf(container);
          value[engineId] = (value[engineId] || 0) + 1;
        }
        cached = { value, expiresAt: now() + ttlMs };
        return value;
      })
      .catch(() => null)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return { counts, clear: () => { cached = null; } };
}

function formatRegistryError(item) {
  const formatted = {
    source: item.source || "registry",
    engineId: item.engineId || "",
    path: item.path || "",
    code: item.code,
    message: item.message,
  };
  if (item.file) formatted.file = item.file;
  if (Number.isInteger(item.index)) formatted.index = item.index;
  return formatted;
}

/** The GET /api/engines body (01 §21.1) for the engines this manager hosts. */
async function buildEnginesPayload(options = {}) {
  const { registry, presence = null, instanceCounts = null } = options;
  const managerId = normalizeManagerId(options.managerId);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const isIntrospected = typeof options.isIntrospected === "function" ? options.isIntrospected : () => false;
  const counts = instanceCounts ? await instanceCounts.counts() : null;
  const presenceAnswers = [];

  const engines = await Promise.all(registry.hostedBy(managerId).map(async (engineId) => {
    const descriptor = registry.get(engineId);
    let defaultIntrospection = null;
    const runtimes = await Promise.all(registry.runtimesFor(engineId).map(async (ref) => {
      const present = presence ? await presence.present(ref.image) : null;
      let introspection = null;
      if (typeof options.getIntrospection === "function") {
        try { introspection = await options.getIntrospection(ref); } catch {}
      }
      if (ref.default) defaultIntrospection = introspection;
      presenceAnswers.push(present);
      return {
        runtimeId: ref.runtimeId,
        manifestKey: ref.manifestKey,
        label: ref.label,
        version: ref.version,
        compatVersion: ref.compatVersion,
        image: ref.image,
        ...(ref.imageOverrideEnv ? { imageOverrideEnv: ref.imageOverrideEnv } : {}),
        default: ref.default,
        present,
        introspected: Boolean(introspection || isIntrospected(ref.runtimeId)),
        features: clone(ref.features),
        status: ref.status,
        localBuild: ref.localBuild,
        pullPolicy: ref.pullPolicy,
      };
    }));
    return {
      engineId,
      label: clone(descriptor.label),
      description: clone(descriptor.description || null),
      family: descriptor.family,
      adapter: descriptor.adapter,
      tier: descriptor.tier,
      status: descriptor.status,
      hostKinds: typeof registry.hostKindsFor === "function" ? registry.hostKindsFor(descriptor) : [...descriptor.host.kinds],
      artifactFormats: [...descriptor.artifactFormats],
      runtimes,
      capabilities: refineAutoParsers(descriptor.capabilities, defaultIntrospection),
      apiSurface: clone(descriptor.apiSurface || null),
      memoryModel: { kind: descriptor.memoryModel.kind },
      health: {
        host: typeof registry.defaultHostKindFor === "function" ? registry.defaultHostKindFor(descriptor) : descriptor.host.default,
        hostReady: null,
        instances: null,
      },
    };
  }));

  // One Docker host per manager: it is ready when it answered for any image.
  const hostReady = !presence || presenceAnswers.length === 0 ? null : presenceAnswers.some((value) => value !== null);
  // The managers' container listings answer [] when Docker is down, so an empty
  // count from a host that answered no image probe is unknown, not zero.
  const countsKnown = Boolean(counts) && !(hostReady === false && Object.keys(counts).length === 0);
  for (const engine of engines) {
    engine.health.hostReady = hostReady;
    engine.health.instances = countsKnown ? counts[engine.engineId] || 0 : null;
  }

  // Each manager reports the problems of the engines it hosts plus the shared
  // ones (the manifest, unreadable files, engines that failed to load); an
  // engine another manager hosts is that manager's to report.
  const hosted = new Set(registry.hostedBy(managerId));
  const errors = [
    ...registry.errors(),
    // A recipe file that failed to load (its last good version stays in use).
    ...(options.recipeStore ? options.recipeStore.errors() : []),
  ]
    .filter((item) => !item.engineId || hosted.has(item.engineId) || !registry.has(item.engineId))
    .map(formatRegistryError);

  return {
    ok: true,
    managerId,
    generatedAt: new Date(now()).toISOString(),
    engines,
    errors,
  };
}

function recipeLabel(recipe) {
  return { zh: recipe.label?.zh || recipe.id, en: recipe.label?.en || recipe.id };
}

// One recipe as the schema endpoint lists it: what the console shows and what
// its appliesWhen/lock editing needs (01 §21.1).
function recipeView(recipe, match, store) {
  return {
    id: recipe.id,
    kind: recipe.kind,
    label: recipeLabel(recipe),
    ...(recipe.description ? { description: clone(recipe.description) } : {}),
    status: recipe.status,
    source: store.sourceOf(recipe.id),
    ...(match ? { eligible: match.eligible, score: match.score, reasons: [...match.reasons] } : {}),
    locks: clone(recipe.locks || []),
    values: clone(recipe.values || {}),
    profile: clone(recipe.profile || null),
  };
}

/** Model recipes of the engine ranked for the model and host, and the manager's scenarios. */
function recipeListing({ store, engineId, managerId, model, host, runtime }) {
  const matches = matchRecipes({ engineId, model: model || {}, hostFacts: host, runtime }, store);
  return {
    recipes: matches.map((match) => recipeView(match.recipe, match, store)),
    scenarios: store.list({ kind: "scenario", managerId }).map((recipe) => recipeView(recipe, null, store)),
  };
}

/**
 * The runtime a schema is made for: ?runtime= names a runtimeId or a manifest
 * key of this engine; without it the engine's default runtime (env image
 * overrides applied, as the launch uses it).
 */
function selectSchemaRuntime(registry, engineId, selector) {
  if (!selector) return registry.defaultRuntime(engineId);
  const runtimes = registry.runtimesFor(engineId);
  const found = runtimes.find((ref) => ref.runtimeId === selector || ref.manifestKey === selector);
  if (!found) {
    throw httpError(404, "unknown_runtime", `Unknown runtime for ${engineId}: ${selector.slice(0, 64)}`,
      `Known runtimes: ${runtimes.map((ref) => ref.runtimeId).join(", ") || "(none)"}`);
  }
  return found;
}

// Host facts from the manager's cached GPU probe; a failed probe leaves the
// GPU facts unknown (null) instead of claiming "no SM12x GPU".
async function readHostFacts(getGpuStatus, platform) {
  if (typeof getGpuStatus !== "function") return hostFactsFromGpus(null, platform);
  try {
    const status = await getGpuStatus();
    return hostFactsFromGpus(status?.ok && Array.isArray(status.gpus) ? status.gpus : null, platform);
  } catch {
    return hostFactsFromGpus(null, platform);
  }
}

/**
 * The GET /api/engines/:engineId/schema body (01 §21.1): the engine's
 * parameter catalog for one runtime, every param with its legacy domId,
 * availability and effective choices, plus the facts that appliesWhen, rules
 * and platform defaults read, so the console can evaluate them itself.
 * Without introspection every runtime flag is "unverified". recipes are the
 * engine's model recipes ranked for ?model= and the host, scenarios the
 * manager's builtin launch profiles (options.recipeStore; empty without one).
 *
 * query: { runtime?, model?, instanceMode? }. Hooks (all optional):
 *   getGpuStatus()                → the manager's cached GPU probe
 *   getIntrospection(runtimeRef)  → { capturedAt, flags[] } | null
 *   getModelFacts(modelRef, ctx)  → { capabilityId, familyId, quantMethod, architectures, nativeMtp } | null
 */
async function buildEngineSchemaPayload(options = {}) {
  const { registry, query = {} } = options;
  const catalogLoader = options.paramCatalog || getParamCatalog();
  const managerId = normalizeManagerId(options.managerId);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const descriptor = registry.require(options.engineId);
  const engineId = descriptor.id;
  if (!registry.hostedBy(managerId).includes(engineId)) {
    throw httpError(404, "engine_not_hosted", `Engine ${engineId} is not hosted by the ${managerId} manager.`,
      `Ask the ${descriptor.hostManager} manager: /api/m/${descriptor.hostManager}/engines/${engineId}/schema`);
  }
  const runtime = selectSchemaRuntime(registry, engineId, queryText(query.runtime));

  let introspection = null;
  if (runtime && typeof options.getIntrospection === "function") {
    try {
      introspection = (await options.getIntrospection(runtime)) || null;
    } catch {
      introspection = null;
    }
  }
  const catalog = catalogLoader.loadCatalog(engineId, { runtime, introspected: introspection });

  const modelRef = queryText(query.model);
  let model = null;
  if (modelRef && typeof options.getModelFacts === "function") {
    try {
      model = (await options.getModelFacts(modelRef, { engineId, runtime })) || null;
    } catch {
      model = null;
    }
  }
  const mode = queryText(query.instanceMode);
  const host = await readHostFacts(options.getGpuStatus, options.platform || process.platform);
  const facts = buildFacts({
    host,
    model,
    runtime,
    instanceMode: INSTANCE_MODES.includes(mode) ? mode : null,
    factNames: catalog.factNames,
  });
  // Without a recipe store (no recipe data wired in) the lists stay empty.
  const listing = options.recipeStore
    ? recipeListing({ store: options.recipeStore, engineId, managerId, model, host, runtime })
    : { recipes: [], scenarios: [] };
  const payload = buildSchemaPayload({ catalog, runtime, introspection, facts, recipes: listing.recipes, scenarios: listing.scenarios });
  return { ...payload, managerId, generatedAt: new Date(now()).toISOString() };
}

/**
 * POST /api/engines/descriptors/validate body → { status, payload }. Runs the
 * "draft" rules (an existing id is an override limited to the override fields,
 * a new id must use a data-driven adapter), then re-checks the merged result
 * and its runtimes against the manifest through registry.checkOverride, the
 * same verdict load() gives an override file. Nothing is written and the
 * registry is not changed.
 */
function validateDraftRequest(registry, body) {
  if (!isPlainObject(body) || body.descriptor === undefined) {
    return { status: 400, payload: errorEnvelope("invalid_body", "The request body must be {\"descriptor\": {...}}.") };
  }
  const { descriptor } = body;
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(descriptor) ?? "", "utf8");
  } catch {
    // Only a pathological body gets here: nesting JSON.parse accepted but
    // too deep to serialize again.
    return { status: 400, payload: errorEnvelope("invalid_body", "The descriptor draft is nested too deeply to check.") };
  }
  if (size > MAX_DRAFT_BYTES) {
    return {
      status: 413,
      payload: errorEnvelope("descriptor_too_large", `A descriptor draft may be at most ${MAX_DRAFT_BYTES / 1024} KiB (got ${Math.ceil(size / 1024)} KiB).`),
    };
  }
  const { ok, kind, errors } = registry.checkOverride(descriptor, { mode: "draft" });
  return { status: 200, payload: { ok, kind, errors } };
}

/**
 * GET /api/instances/:id/metrics → { status, payload }. The id resolves
 * against the sampler's last listing (the P0-RT-4 ownership rule), never
 * against Docker, and the body is the sampler's latest snapshot: a request
 * never scrapes. Until the first listing has finished, no id can be judged
 * unknown, so the answer is 503 metrics_not_ready instead of a false 404.
 */
function readInstanceMetrics(sampler, instanceId) {
  if (!sampler.ready()) {
    return {
      status: 503,
      payload: errorEnvelope("metrics_not_ready", "The metrics sampler has not listed this manager's instances yet.", "Retry in a few seconds."),
    };
  }
  const payload = sampler.read(typeof instanceId === "string" ? instanceId : "");
  if (!payload) {
    const shown = String(instanceId ?? "").slice(0, 64);
    return {
      status: 404,
      payload: errorEnvelope("unknown_instance", `Unknown instance: ${shown || "(empty)"}`, "List this manager's instances with GET /api/instances."),
    };
  }
  return { status: 200, payload };
}

function createLogRedactor(input) {
  const custom = typeof input === "function" ? input
    : (input && typeof input.redact === "function" ? (value) => input.redact(value) : null);
  return (value) => {
    if (!custom) return redactSecrets(value);
    try {
      return custom(value);
    } catch {
      return redactSecrets(value);
    }
  };
}

/** A copy of a JSON value with every string passed through the redactor. */
function redactStrings(value, redact) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, redact));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item, redact)]));
}

/** "docker run …" for a redacted argv: arguments with spaces or quotes are double-quoted. */
function dockerCommandText(argv) {
  const quote = (arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\])/g, "\\$1")}"`);
  const args = (Array.isArray(argv) ? argv : []).map(String);
  return `docker ${args.map(quote).join(" ")}`.trim();
}

/** The LaunchStore spec of an instance as a LaunchRequestV2 (01 §4): what POST /api/start plans. */
function relaunchRequest(record, { overrides, apiKey } = {}) {
  const spec = record.spec || {};
  const values = { ...(isPlainObject(spec.values) ? spec.values : {}), ...(isPlainObject(overrides?.values) ? overrides.values : {}) };
  return {
    engineId: spec.engineId,
    ...(spec.runtimeId ? { runtimeId: spec.runtimeId } : {}),
    ...(spec.recipeId ? { recipeId: spec.recipeId } : {}),
    ...(spec.runtimeImage ? { runtime: { imageOverride: spec.runtimeImage } } : {}),
    model: { ref: spec.model?.ref, ...(spec.model?.servedName ? { servedName: spec.model.servedName } : {}) },
    instance: {
      mode: spec.instance?.mode,
      ...(spec.instance?.id ? { id: spec.instance.id } : {}),
      ...(spec.instance?.port ? { port: spec.instance.port } : {}),
      networkAccess: spec.instance?.networkAccess,
      ...(spec.instance?.gpuIds?.length ? { gpuIds: [...spec.instance.gpuIds] } : {}),
    },
    values,
    ...(spec.extraArgs?.length ? { extraArgs: [...spec.extraArgs] } : {}),
    ...(isPlainObject(spec.extraEnv) && Object.keys(spec.extraEnv).length ? { extraEnv: { ...spec.extraEnv } } : {}),
    ...(apiKey ? { apiKey } : {}),
    source: "relaunch",
    fromLaunchId: record.launchId,
  };
}

/** The launch id the supervisor stamps on job.meta once the job starts building its command. */
async function waitForLaunchId(job, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!job?.meta?.launchId && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return job?.meta?.launchId || null;
}

function registerEngineRoutes(app, deps = {}) {
  const { registry } = deps;
  if (!registry || typeof registry.hostedBy !== "function" || typeof registry.checkOverride !== "function") {
    throw new TypeError("registerEngineRoutes needs an engine registry.");
  }
  const managerId = normalizeManagerId(deps.managerId);
  if (!managerId) throw new TypeError(`registerEngineRoutes: unknown managerId ${deps.managerId}`);
  // Writes stay local-only, deny by default when the caller passes no predicate.
  const isLocalRequest = typeof deps.isLocalRequest === "function" ? deps.isLocalRequest : () => false;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const presence = typeof deps.getImageStatus === "function"
    ? createImagePresenceProbe({ getImageStatus: deps.getImageStatus, ttlMs: deps.imagePresenceTtlMs, now })
    : null;
  const instanceCounts = typeof deps.listManagedContainers === "function"
    ? createInstanceCounter({
      listManagedContainers: deps.listManagedContainers,
      ownerLabelValue: deps.ownerLabelValue,
      registry,
      managerId,
      now,
    })
    : null;
  const metricsSampler = deps.metricsSampler && typeof deps.metricsSampler.read === "function" ? deps.metricsSampler : null;
  const runtimeFacts = deps.runtimeFacts || createRuntimeFacts({
    registry,
    aiRoot: deps.aiRoot,
    now,
    resolveImageId: presence ? presence.imageId : async () => null,
  });
  const getIntrospection = deps.getIntrospection || (async (runtime) => (await runtimeFacts.get(runtime.runtimeId))?.flags || null);
  const isAdminRequest = deps.isAdminRequest || isLocalRequest;

  function requireHostedRuntime(req) {
    const descriptor = registry.require(req.params?.engineId);
    if (!registry.hostedBy(managerId).includes(descriptor.id)) throw httpError(404, "engine_not_hosted", `Engine ${descriptor.id} is not hosted by this manager.`);
    return { descriptor, runtime: registry.resolveRuntime(descriptor.id, { runtimeId: req.params?.runtimeId }) };
  }

  function sendRuntimeError(res, error) {
    return res.status(error.status || 500).json(errorEnvelope(error.code || "runtime_facts_unavailable", error.message, error.hint));
  }

  app.get("/api/engines", async (_req, res) => {
    try {
      res.json(await buildEnginesPayload({
        registry,
        managerId,
        presence,
        instanceCounts,
        isIntrospected: deps.isIntrospected,
        recipeStore: deps.recipeStore,
        getIntrospection,
        now,
      }));
    } catch (error) {
      res.status(500).json(errorEnvelope("engines_unavailable", error.message));
    }
  });

  app.get("/api/engines/:engineId/schema", async (req, res) => {
    try {
      res.json(await buildEngineSchemaPayload({
        registry,
        managerId,
        engineId: req.params?.engineId,
        query: req.query || {},
        paramCatalog: deps.paramCatalog,
        getGpuStatus: deps.getGpuStatus,
        getIntrospection,
        getModelFacts: deps.getModelFacts,
        recipeStore: deps.recipeStore,
        now,
      }));
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
      res.status(status).json(errorEnvelope(error.code || "schema_unavailable", error.message, error.hint));
    }
  });

  app.post("/api/engines/descriptors/validate", (req, res) => {
    if (!isLocalRequest(req)) {
      return res.status(403).json(errorEnvelope("forbidden", "Descriptor validation is only available from this computer."));
    }
    const { status, payload } = validateDraftRequest(registry, req.body);
    return res.status(status).json(payload);
  });

  // The launch plan (01 §11, 00 §4.3 and §9.2): the plan POST /api/start would
  // execute for this body (a LaunchRequestV2 or a legacy /api/start body),
  // without creating a job, taking a lease or touching a container. Every plan
  // problem answers 200 with ok:false; 400 is only a malformed body or an
  // unknown engine.
  if (typeof deps.planLaunch === "function") {
    app.post("/api/launch/plan", async (req, res) => {
      if (!isLocalRequest(req)) {
        return res.status(403).json(errorEnvelope("forbidden", "Launch plans are only available from this computer."));
      }
      try {
        return res.json(publicPlan(await deps.planLaunch(req.body)));
      } catch (error) {
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
        return res.status(status).json({
          ...errorEnvelope(error.code || (status === 500 ? "launch_plan_failed" : "invalid_request"), error.message, error.hint),
          ...(error.details ? { details: clone(error.details) } : {}),
        });
      }
    });
  }

  // POST /api/launch (01 §11, 00 §9.3): /api/start for LaunchRequestV2 only (a
  // legacy body is 400 v2_body_required), also {fromLaunchId, instance?,
  // onConflict?, expectedPlanHash?, source?}. Same handler, responses and
  // errors as /api/start: the job, the add/skip result, 409 plan_changed.
  // Admission needs no extra check here; /api/start has none either.
  if (typeof deps.startLaunch === "function") {
    app.post("/api/launch", async (req, res) => {
      try {
        res.json(await deps.startLaunch({ req, body: req.body || {} }));
      } catch (error) {
        sendJsonError(res, error);
      }
    });
  }

  // Re-reads <AI_ROOT>/config/recipes (01 §10.3): the entry calls it after it
  // writes a recipe file. An invalid file keeps its last good version and is
  // listed in errors[] (ok:false); plans already resolved keep their snapshot.
  const recipeStore = deps.recipeStore || null;
  if (recipeStore) {
    app.post("/api/recipes/reload", (req, res) => {
      if (!isLocalRequest(req)) {
        return res.status(403).json(errorEnvelope("forbidden", "Recipes can only be reloaded from this computer."));
      }
      try {
        return res.json(recipeStore.reload());
      } catch (error) {
        return res.status(500).json(errorEnvelope("recipe_reload_failed", error.message));
      }
    });
  }

  app.get("/api/engines/:engineId/runtimes/:runtimeId/flags", async (req, res) => {
    try {
      const { descriptor, runtime } = requireHostedRuntime(req);
      const facts = await runtimeFacts.get(runtime.runtimeId);
      if (!facts?.flags) throw httpError(404, "runtime_not_introspected", "请先检测运行时参数 / Introspect runtime flags first");
      const payload = { ok: true, engineId: descriptor.id, runtimeId: runtime.runtimeId, imageId: facts.imageId, flags: facts.flags, registries: facts.registries };
      const against = queryText(req.query?.against);
      if (against) {
        const catalog = (deps.paramCatalog || getParamCatalog()).loadCatalog(descriptor.id, { runtime });
        let baseline;
        if (against === "catalog") {
          baseline = catalog.params.flatMap((param) => [param.emit.flag, param.emit.falseFlag, ...(param.flags || []).map((entry) => entry.flag)].filter(Boolean).map((flag) => ({ flag, choices: (param.choices || []).map((entry) => entry.value), default: param.engineDefault })));
        } else {
          const other = registry.resolveRuntime(descriptor.id, { runtimeId: against });
          baseline = (await runtimeFacts.get(other.runtimeId))?.flags;
          if (!baseline) throw httpError(404, "runtime_not_introspected", "The comparison runtime has no introspected flags.");
        }
        payload.diff = diffFlagSets(baseline, facts.flags, catalog);
      }
      return res.json(payload);
    } catch (error) { return sendRuntimeError(res, error); }
  });

  app.post("/api/engines/:engineId/runtimes/:runtimeId/introspect", async (req, res) => {
    if (!isAdminRequest(req)) return res.status(403).json(errorEnvelope("forbidden", "Flag introspection requires administrator access."));
    if (req.body?.confirm !== true) return res.status(400).json(errorEnvelope("confirmation_required", "Confirm the runtime flag introspection with confirm:true."));
    try {
      const { descriptor, runtime } = requireHostedRuntime(req);
      // Validate support and image presence before creating a ledger job.
      buildIntrospectionCommand(descriptor, runtime.image);
      if (!["createJob", "finishJob", "failJob"].every((name) => typeof deps[name] === "function")) throw httpError(503, "introspection_unavailable", "The introspection job runner is unavailable.");
      if (!await runtimeFacts.imageId(runtime.image, { force: true })) throw httpError(409, "runtime_image_missing", "请先拉取镜像 / Pull the image first");
      const job = deps.createJob("introspect", `检测运行时参数 / Introspect ${runtime.runtimeId}`, { engineId: descriptor.id, runtimeId: runtime.runtimeId });
      const runner = deps.introspectRuntime || introspectRuntime;
      // Send a snapshot of the job before the background work can finish.
      res.json({ job: clone(job) });
      Promise.resolve().then(() => runner(descriptor.id, runtime.runtimeId, { registry, runtimeFacts, dockerConfig: deps.dockerConfig, execFileAsync: deps.execFileAsync, now }))
        .then((result) => {
          deps.appendLog?.(job, `检测完成 / Captured ${result.flags.flags.length} runtime flags.`);
          deps.finishJob(job, { imageId: result.imageId, flagCount: result.flags.flags.length });
        })
        .catch((error) => {
          // Keep the machine-readable error in the existing job envelope too.
          job.meta.errorCode = error.code || "introspection_failed";
          deps.failJob(job, error);
        });
      return res;
    } catch (error) { return sendRuntimeError(res, error); }
  });

  // Per-instance logs, launch record and relaunch (ENG-13). An instance id
  // resolves through the manager's own instance list or its P0-RT-4 container
  // resolver, never from a caller-provided container name.
  const redactLogs = createLogRedactor(deps.redactLogs);
  const redactArgv = (argv) => (Array.isArray(argv) ? argv : []).map((arg) => redactLogs(String(arg)));

  async function findInstance(req) {
    const id = typeof req.params?.id === "string" ? req.params.id.trim() : "";
    if (!INSTANCE_ID_PATTERN.test(id) || typeof deps.findInstance !== "function") return null;
    return deps.findInstance(id);
  }

  function unknownInstance(res, id) {
    const shown = String(id ?? "").slice(0, 64);
    return res.status(404).json(errorEnvelope("unknown_instance", `Unknown instance: ${shown || "(empty)"}`, "List this manager's instances with GET /api/instances."));
  }

  if (typeof deps.resolveLogContainer === "function" && typeof deps.docker === "function") {
    app.get("/api/instances/:id/logs", async (req, res) => {
      try {
        const id = typeof req.params?.id === "string" ? req.params.id.trim() : "";
        const containerName = INSTANCE_ID_PATTERN.test(id) ? await deps.resolveLogContainer(id) : null;
        if (!containerName) return unknownInstance(res, id);
        const requested = Math.floor(Number(queryText(req.query?.tail)));
        const tail = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LOG_TAIL) : DEFAULT_LOG_TAIL;
        const since = queryText(req.query?.since);
        if (since && !Number.isFinite(Date.parse(since))) {
          return res.status(400).json(errorEnvelope("invalid_since", "since must be an ISO 8601 time.", "Example: since=2026-10-14T08:00:00Z"));
        }
        const out = await deps.docker(["logs", "--tail", String(tail), ...(since ? ["--since", since] : []), String(containerName)], {
          rejectOnError: false,
          maxBuffer: 16 * 1024 * 1024,
        });
        const raw = `${out?.stdout || ""}${out?.stderr || ""}`;
        const lines = raw ? raw.replace(/\r?\n$/, "").split(/\r?\n/).length : 0;
        return res.json({
          ok: true,
          instanceId: id,
          containerName: String(containerName),
          text: redactLogs(raw),
          truncated: lines >= tail,
          redacted: true,
        });
      } catch (error) {
        return res.status(500).json(errorEnvelope("logs_unavailable", redactLogs(String(error?.message ?? ""))));
      }
    });
  }

  if (typeof deps.findInstance === "function" && deps.launchStore) {
    const recordOf = (state) => deps.launchStore.resolveForInstance(state, {
      jobsLedgerLookup: deps.jobsLedgerLookup,
      recentLaunches: typeof deps.listRecentLaunches === "function" ? deps.listRecentLaunches() : undefined,
    });

    app.get("/api/instances/:id/launch", async (req, res) => {
      try {
        const found = await findInstance(req);
        if (!found) return unknownInstance(res, req.params?.id);
        const record = recordOf(found.state);
        if (!record) return res.status(404).json(errorEnvelope("launch_not_found", "No launch record matches this instance."));
        const launch = redactStrings(record, redactLogs);
        const argv = redactArgv(record.resolved?.argvRedacted);
        return res.json({ ok: true, launch, command: { argv, docker: dockerCommandText(argv) } });
      } catch (error) {
        return res.status(500).json(errorEnvelope("launch_unavailable", redactLogs(String(error?.message ?? ""))));
      }
    });

    app.post("/api/instances/:id/relaunch", async (req, res) => {
      if (!isAdminRequest(req)) return res.status(403).json(errorEnvelope("forbidden", "Relaunching an instance requires administrator access."));
      if (req.body?.confirm !== true) return res.status(400).json(errorEnvelope("confirmation_required", "Confirm the relaunch with confirm:true."));
      const overrides = req.body?.overrides;
      if (overrides !== undefined && (!isPlainObject(overrides) || (overrides.values !== undefined && !isPlainObject(overrides.values)))) {
        return res.status(400).json(errorEnvelope("invalid_body", "overrides must be {values:{…}}."));
      }
      const expectedPlanHash = req.body?.expectedPlanHash;
      if (expectedPlanHash !== undefined && typeof expectedPlanHash !== "string") {
        return res.status(400).json(errorEnvelope("invalid_body", "expectedPlanHash must be a string."));
      }
      if (typeof deps.startRuntime !== "function") return res.status(503).json(errorEnvelope("relaunch_unavailable", "This manager cannot start runtimes."));
      try {
        const found = await findInstance(req);
        if (!found) return unknownInstance(res, req.params?.id);
        const record = recordOf(found.state);
        if (!record || record.partial) {
          return res.status(409).json(errorEnvelope("launch_config_partial", "This instance has no complete launch record, so it cannot be relaunched.", "Start it again from the launch form."));
        }
        const apiKey = typeof deps.apiKeyFor === "function" ? String(await deps.apiKeyFor(found) || "") : "";
        const body = relaunchRequest(record, { overrides, apiKey });
        if (expectedPlanHash) {
          if (typeof deps.planLaunch !== "function") return res.status(503).json(errorEnvelope("relaunch_unavailable", "This manager cannot plan launches."));
          const plan = await deps.planLaunch(body);
          if (plan.planHash !== expectedPlanHash) {
            return res.status(409).json({
              ...errorEnvelope("plan_changed", "The launch plan changed since it was shown.", "Review the new plan and confirm again."),
              details: { expectedPlanHash, planHash: plan.planHash ?? null, plan: publicPlan(plan) },
            });
          }
        }
        // A parallel instance owns its container name, so it has to go first;
        // a replace launch replaces the running container as its own plan step.
        if (found.instance?.instanceMode === "parallel" && found.instance?.containerName && typeof deps.stopInstance === "function") {
          await deps.stopInstance({ id: found.instance.id });
        }
        const started = await deps.startRuntime({ body });
        const job = started?.job || null;
        const launchId = await waitForLaunchId(job, deps.relaunchLaunchIdWaitMs ?? RELAUNCH_LAUNCH_ID_WAIT_MS);
        return res.json({ job: clone(job), launchId, ...(started?.plan ? { plan: clone(started.plan) } : {}) });
      } catch (error) {
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
        return res.status(status).json({
          ...errorEnvelope(error.code || (status === 500 ? "relaunch_failed" : "invalid_request"), redactLogs(String(error?.message ?? "")), error.hint),
          ...(Array.isArray(error.errors) ? { errors: clone(error.errors) } : {}),
          ...(error.details ? { details: clone(error.details) } : {}),
        });
      }
    });
  }

  // The explicit pull behind the image_pull_required blocker (00 §9.2): an
  // admin action with confirm:true that starts (or joins) an image-pull job.
  // deps.pullRuntime is the supervisor's; this route never touches a
  // container or a GPU lease.
  app.post("/api/runtimes/:runtimeId/pull", async (req, res) => {
    if (!isAdminRequest(req)) return res.status(403).json(errorEnvelope("forbidden", "Runtime image pulls require administrator access."));
    if (req.body?.confirm !== true) {
      return res.status(400).json(errorEnvelope("confirm_required", "Confirm the image pull with confirm:true.", "拉取镜像需要确认 / Confirm the pull first"));
    }
    if (typeof deps.pullRuntime !== "function") return res.status(503).json(errorEnvelope("pull_unavailable", "Runtime image pulls are not available on this manager."));
    try {
      // A finished pull changes what the plan's pull step and /api/engines see.
      const { job, existing } = await deps.pullRuntime(req.params?.runtimeId, { source: "api", onSettled: () => presence?.clear() });
      return res.status(202).json({ ok: true, existing: Boolean(existing), job: { ...summarizeJob(clone(job)), existing: Boolean(existing) } });
    } catch (error) {
      return res.status(error.status || 500).json(errorEnvelope(error.code || "pull_failed", error.message, error.hint));
    }
  });

  if (metricsSampler) {
    app.get("/api/instances/:id/metrics", (req, res) => {
      const { status, payload } = readInstanceMetrics(metricsSampler, req.params?.id);
      res.status(status).json(payload);
    });
  }

  return { presence, instanceCounts, metricsSampler, runtimeFacts };
}

module.exports = {
  MAX_DRAFT_BYTES,
  buildEngineSchemaPayload,
  buildEnginesPayload,
  createImagePresenceProbe,
  createInstanceCounter,
  errorEnvelope,
  findHostedRuntime,
  readInstanceMetrics,
  registerEngineRoutes,
  validateDraftRequest,
};
