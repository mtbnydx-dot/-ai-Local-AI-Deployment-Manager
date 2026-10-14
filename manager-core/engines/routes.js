"use strict";

// Manager routes for the engine registry (docs/overhaul/01-engines.md §21.1):
//   GET  /api/engines                      hosted engines, runtimes, health
//   POST /api/engines/descriptors/validate side-effect-free draft validation
//   GET  /api/engines/:engineId/schema     parameter catalog + availability + facts
// Later packages (metrics, launch plan) add their routes here too.
// Docker is touched only through the injected getImageStatus/listManagedContainers
// reads, both cached, so a dashboard polling this route stays cheap.

const { isPlainObject } = require("./descriptor-schema");
const { buildFacts, buildSchemaPayload, getParamCatalog, hostFactsFromGpus } = require("./param-catalog");
const { normalizeManagerId } = require("./registry");

const MAX_DRAFT_BYTES = 256 * 1024;
const IMAGE_PRESENCE_TTL_MS = 60_000;
// "Docker is down" is re-checked sooner than a known present/missing answer.
const IMAGE_UNKNOWN_TTL_MS = 5_000;
const INSTANCE_COUNT_TTL_MS = 10_000;
const ENGINE_ID_LABEL_KEY = "ai.manager.engine-id";
const LEGACY_ENGINE_LABEL_KEY = "ai.manager.engine";
const INSTANCE_MODES = Object.freeze(["replace", "parallel", "add"]);
const MAX_QUERY_TEXT = 1024;

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
      if (status?.ok) return true;
      if (status?.reason === "missing-image") return false;
      return null;
    } catch {
      return null;
    }
  }

  function present(image) {
    const key = String(image || "").trim();
    if (!key || typeof getImageStatus !== "function") return Promise.resolve(null);
    const cached = entries.get(key);
    if (cached?.promise) return cached.promise;
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value);
    const promise = inspect(key).then((value) => {
      entries.set(key, { value, expiresAt: now() + (value === null ? unknownTtlMs : ttlMs) });
      return value;
    });
    entries.set(key, { ...(cached || {}), promise });
    return promise;
  }

  return { present, clear: () => entries.clear() };
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
    const runtimes = await Promise.all(registry.runtimesFor(engineId).map(async (ref) => {
      const present = presence ? await presence.present(ref.image) : null;
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
        introspected: Boolean(isIntrospected(ref.runtimeId)),
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
      hostKinds: [...descriptor.host.kinds],
      artifactFormats: [...descriptor.artifactFormats],
      runtimes,
      capabilities: clone(descriptor.capabilities),
      apiSurface: clone(descriptor.apiSurface || null),
      memoryModel: { kind: descriptor.memoryModel.kind },
      health: {
        host: descriptor.host.default,
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
  const errors = registry.errors()
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
 * Without introspection every runtime flag is "unverified". Recipes and
 * scenarios stay empty until recipes are data (ENG-6).
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
  const payload = buildSchemaPayload({ catalog, runtime, introspection, facts, recipes: [], scenarios: [] });
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

  app.get("/api/engines", async (_req, res) => {
    try {
      res.json(await buildEnginesPayload({
        registry,
        managerId,
        presence,
        instanceCounts,
        isIntrospected: deps.isIntrospected,
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
        getIntrospection: deps.getIntrospection,
        getModelFacts: deps.getModelFacts,
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

  return { presence, instanceCounts };
}

module.exports = {
  MAX_DRAFT_BYTES,
  buildEngineSchemaPayload,
  buildEnginesPayload,
  createImagePresenceProbe,
  createInstanceCounter,
  errorEnvelope,
  registerEngineRoutes,
  validateDraftRequest,
};
