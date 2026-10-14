"use strict";

// Manager routes for the engine registry (docs/overhaul/01-engines.md §21.1):
//   GET  /api/engines                      hosted engines, runtimes, health
//   POST /api/engines/descriptors/validate side-effect-free draft validation
// Later packages (schema, metrics, launch plan) add their routes here too.
// Docker is touched only through the injected getImageStatus/listManagedContainers
// reads, both cached, so a dashboard polling this route stays cheap.

const { isPlainObject, validateDescriptor } = require("./descriptor-schema");
const { mergeDescriptor, normalizeManagerId } = require("./registry");

const MAX_DRAFT_BYTES = 256 * 1024;
const IMAGE_PRESENCE_TTL_MS = 60_000;
// "Docker is down" is re-checked sooner than a known present/missing answer.
const IMAGE_UNKNOWN_TTL_MS = 5_000;
const INSTANCE_COUNT_TTL_MS = 10_000;
const ENGINE_ID_LABEL_KEY = "ai.manager.engine-id";
const LEGACY_ENGINE_LABEL_KEY = "ai.manager.engine";

// 00 §4.2 error envelope for the new admin JSON APIs.
function errorEnvelope(code, message, hint) {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } };
}

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
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
        instances: counts ? counts[engineId] || 0 : null,
      },
    };
  }));

  // One Docker host per manager: it is ready when it answered for any image.
  const hostReady = !presence || presenceAnswers.length === 0 ? null : presenceAnswers.some((value) => value !== null);
  for (const engine of engines) engine.health.hostReady = hostReady;

  return {
    ok: true,
    managerId,
    generatedAt: new Date(now()).toISOString(),
    engines,
    errors: registry.errors().map(formatRegistryError),
  };
}

/**
 * POST /api/engines/descriptors/validate body → { status, payload }. Runs the
 * "draft" rules (an existing id is an override limited to the override fields,
 * a new id must use a data-driven adapter) and, for an override, re-checks the
 * merged result. Nothing is written and the registry is not changed.
 */
function validateDraftRequest(registry, body) {
  if (!isPlainObject(body) || body.descriptor === undefined) {
    return { status: 400, payload: errorEnvelope("invalid_body", "The request body must be {\"descriptor\": {...}}.") };
  }
  const { descriptor } = body;
  const size = Buffer.byteLength(JSON.stringify(descriptor) ?? "", "utf8");
  if (size > MAX_DRAFT_BYTES) {
    return {
      status: 413,
      payload: errorEnvelope("descriptor_too_large", `A descriptor draft may be at most ${MAX_DRAFT_BYTES / 1024} KiB (got ${Math.ceil(size / 1024)} KiB).`),
    };
  }
  const result = validateDescriptor(descriptor, { mode: "draft", knownIds: registry.list().map((item) => item.id) });
  let errors = result.errors;
  if (result.ok && result.kind === "override") {
    errors = validateDescriptor(mergeDescriptor(registry.get(descriptor.id), descriptor), { mode: "bundled" }).errors;
  }
  return { status: 200, payload: { ok: errors.length === 0, kind: result.kind, errors } };
}

function registerEngineRoutes(app, deps = {}) {
  const { registry } = deps;
  if (!registry || typeof registry.hostedBy !== "function") throw new TypeError("registerEngineRoutes needs an engine registry.");
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
  buildEnginesPayload,
  createImagePresenceProbe,
  createInstanceCounter,
  errorEnvelope,
  registerEngineRoutes,
  validateDraftRequest,
};
