"use strict";

// Typed instances (docs/overhaul/01-engines.md §16.4, 00 §4.1 and §9.17).
// The managers keep building the legacy GET /api/instances item; this module
// decides which containers are instances (registry.hostedBy instead of a
// hard-coded engine list; an unknown engine is still listed and stoppable),
// adds the typed fields next to the legacy ones, and turns idle-unload sleep
// records into instance-shaped items for ?include=sleeping.

const manifest = require("../runtime-manifest");
const { sleepIdOf } = require("../idle-unload");
const { UNKNOWN_ENGINE_ID, normalizeManagerId } = require("./registry");

const ENGINE_ID_LABEL_KEY = "ai.manager.engine-id";
const LEGACY_ENGINE_LABEL_KEY = "ai.manager.engine";
const LAUNCH_ID_LABEL_KEY = "ai.manager.launch-id";
const RECIPE_LABEL_KEY = "ai.manager.recipe";
const RUNTIME_ID_LABEL_KEY = "ai.manager.runtime-id";
const JOB_LABEL_KEY = "ai.manager.job";
const IN_FLIGHT_JOB_STATUSES = new Set(["running", "queued"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

/**
 * The engine id of a managed container, or "" when it is not an engine
 * container at all (no engine-id label and no legacy engine label).
 * A legacy value the registry does not know gives "unknown".
 */
function engineIdOfContainer(container, { registry, managerId } = {}) {
  const labels = isPlainObject(container?.labels) ? container.labels : {};
  const labelled = text(labels[ENGINE_ID_LABEL_KEY]);
  if (labelled && registry.has(labelled)) return labelled;
  const legacy = text(container?.engine ?? labels[LEGACY_ENGINE_LABEL_KEY]);
  if (!legacy && !labelled) return "";
  return registry.fromLegacy(legacy, managerId);
}

/**
 * True when a container is an instance of this manager: its engine is one the
 * manager hosts, or unknown (listed and stoppable, never hidden). The owner
 * check stays with the caller, as it does today.
 */
function isHostedContainer(container, { registry, managerId } = {}) {
  const engineId = engineIdOfContainer(container, { registry, managerId });
  if (!engineId) return false;
  return engineId === UNKNOWN_ENGINE_ID || registry.hostedBy(managerId).includes(engineId);
}

function exitCodeOf(statusText) {
  const match = /^exited \((-?\d+)\)/i.exec(text(statusText));
  return match ? Number(match[1]) : null;
}

function lifecycleOf({ container, job, now }) {
  const history = Array.isArray(job?.lifecycle?.phaseHistory) ? clone(job.lifecycle.phaseHistory) : [];
  const inFlight = Boolean(job) && IN_FLIGHT_JOB_STATUSES.has(job.status);
  if (inFlight) {
    const phase = job.lifecycle?.phase || job.progress?.phase || null;
    const percent = Math.max(0, Math.min(100, Math.floor(Number(job.progress?.percent) || 0)));
    return { state: "loading", phase, percent, since: history.at(-1)?.at || job.createdAt || null, phaseHistory: history };
  }
  const since = job?.finishedAt || job?.updatedAt || null;
  if (container?.running) {
    return { state: "ready", phase: "ready", percent: 100, since, phaseHistory: history };
  }
  const exitCode = exitCodeOf(container?.status);
  return { state: exitCode ? "crashed" : "stopped", phase: null, percent: 0, since: since || (now ? new Date(now()).toISOString() : null), phaseHistory: history };
}

function declaredCapabilities({ descriptor, record, maxContext }) {
  const stored = record?.resolved?.capabilities;
  if (isPlainObject(stored)) return clone(stored);
  const roles = Array.isArray(descriptor?.capabilities?.roles) ? descriptor.capabilities.roles : [];
  const parsers = descriptor?.capabilities?.autoParsers || {};
  const values = isPlainObject(record?.spec?.values) ? record.spec.values : {};
  const parserValue = (id) => Object.entries(values).some(([key, value]) => key.toLowerCase().endsWith(id) && value);
  return {
    text: roles.length ? roles.includes("chat") : true,
    vision: false,
    audio: false,
    embedding: roles.includes("embedding") && !roles.includes("chat"),
    rerank: roles.includes("rerank") && !roles.includes("chat"),
    tools: Boolean(parsers.tool) || parserValue("toolcallparser"),
    reasoning: Boolean(parsers.reasoning) || parserValue("reasoningparser"),
    maxContext: Number.isFinite(maxContext) && maxContext > 0 ? maxContext : null,
  };
}

function apiSurfaceOf(descriptor) {
  const surface = isPlainObject(descriptor?.apiSurface) ? descriptor.apiSurface : {};
  const out = {};
  for (const key of ["chat", "completions", "responses", "messages", "embeddings", "rerank"]) out[key] = Boolean(surface[key]);
  return out;
}

/**
 * createInstanceCatalog({ registry, managerId, launchStore?, getJob?, listSleeping?, now? })
 *   .isHosted(container)                 → boolean (hostedBy, or unknown)
 *   .isKnownEngine(container)            → boolean (hostedBy only)
 *   .engineIdOf(container)               → engine id or ""
 *   .typed(instance, container)          → the 00 §4.1 / §9.17 fields for one running or stopped container
 *   .stateOf(instance, container)        → the instance state LaunchStore resolves records from
 *   .sleeping()                          → Promise<instance-shaped sleep records>
 * Nothing here touches Docker; the manager passes in the containers it listed.
 */
function createInstanceCatalog(options = {}) {
  const registry = options.registry;
  if (!registry || typeof registry.hostedBy !== "function") throw new TypeError("createInstanceCatalog needs an engine registry.");
  const managerId = normalizeManagerId(options.managerId);
  if (!managerId) throw new TypeError(`createInstanceCatalog: unknown managerId ${options.managerId}`);
  const launchStore = options.launchStore || null;
  const getJob = typeof options.getJob === "function" ? options.getJob : () => null;
  const listSleeping = typeof options.listSleeping === "function" ? options.listSleeping : null;
  const now = typeof options.now === "function" ? options.now : Date.now;

  const engineIdOf = (container) => engineIdOfContainer(container, { registry, managerId });
  const isHosted = (container) => isHostedContainer(container, { registry, managerId });

  function stateOf(instance, container) {
    const model = instance?.models?.[0] || {};
    return {
      id: instance?.id,
      containerName: container?.name || instance?.containerName,
      running: Boolean(container?.running ?? instance?.running),
      labels: isPlainObject(container?.labels) ? container.labels : {},
      model: text(model.id),
      name: text(model.root) || text(instance?.id),
      engine: text(container?.engine) || text(container?.labels?.[LEGACY_ENGINE_LABEL_KEY]),
    };
  }

  function recordFor(instance, container) {
    if (!launchStore) return null;
    const labelled = text(container?.labels?.[LAUNCH_ID_LABEL_KEY]);
    try {
      if (labelled) return launchStore.get(labelled) || null;
    } catch {}
    return null;
  }

  function runtimeOf({ engineId, container, record }) {
    const image = text(container?.image) || text(record?.spec?.runtimeImage);
    const labelled = text(container?.labels?.[RUNTIME_ID_LABEL_KEY]) || text(record?.spec?.runtimeId);
    let ref = null;
    if (engineId !== UNKNOWN_ENGINE_ID) {
      try {
        ref = registry.resolveRuntime(engineId, labelled ? { runtimeId: labelled } : { image });
      } catch {}
      if (!ref && image) {
        try { ref = registry.resolveRuntime(engineId, { image }); } catch {}
      }
    }
    if (!ref && image) ref = manifest.runtimeForImage(image);
    return {
      id: ref?.runtimeId || labelled || null,
      version: ref?.version || null,
      image,
      digest: text(record?.resolved?.imageId) || null,
    };
  }

  function typed(instance, container) {
    const labels = isPlainObject(container?.labels) ? container.labels : {};
    const engineId = engineIdOf(container) || UNKNOWN_ENGINE_ID;
    const descriptor = engineId === UNKNOWN_ENGINE_ID ? null : registry.get(engineId);
    const record = recordFor(instance, container);
    const job = getJob(text(labels[JOB_LABEL_KEY]) || record?.jobId || "") || null;
    const maxContext = Number(instance?.models?.[0]?.maxModelLen) || Number(record?.spec?.values?.contextLength) || 0;
    return {
      engineId,
      engineFamily: descriptor?.family || UNKNOWN_ENGINE_ID,
      runtime: runtimeOf({ engineId, container, record }),
      recipeId: text(labels[RECIPE_LABEL_KEY]) || record?.spec?.recipeId || null,
      launchId: text(labels[LAUNCH_ID_LABEL_KEY]) || record?.launchId || null,
      lifecycle: lifecycleOf({ container, job, now }),
      capabilities: declaredCapabilities({ descriptor, record, maxContext }),
      apiSurface: apiSurfaceOf(descriptor),
    };
  }

  async function sleeping() {
    if (!listSleeping) return [];
    const listed = await listSleeping();
    const records = Array.isArray(listed?.sleeping) ? listed.sleeping : [];
    return records.map((record) => {
      const id = sleepIdOf(record);
      const engineId = registry.fromLegacy(record.engine, managerId);
      const descriptor = engineId === UNKNOWN_ENGINE_ID ? null : registry.get(engineId);
      const placement = isPlainObject(record.placement) ? record.placement : {};
      const mode = placement.instanceMode === "parallel" ? "parallel" : "replace";
      const stored = record.launchId && launchStore ? launchStore.get(record.launchId) : null;
      return {
        id,
        instanceMode: mode,
        primary: mode === "replace",
        containerName: record.containerName || "",
        running: false,
        status: "sleeping",
        image: "",
        engine: record.engine || "",
        port: Number(stored?.spec?.instance?.port) || 0,
        gpuIds: [],
        vramReservationMb: Number(record.vramMb) || 0,
        models: [{ id: record.model, root: record.name || "", maxModelLen: null, requestsTotal: 0, runningRequests: null, waitingRequests: null, lastKnown: true }],
        engineId,
        engineFamily: descriptor?.family || UNKNOWN_ENGINE_ID,
        runtime: {
          id: stored?.spec?.runtimeId || null,
          version: null,
          image: text(stored?.spec?.runtimeImage),
          digest: text(stored?.resolved?.imageId) || null,
        },
        recipeId: stored?.spec?.recipeId || null,
        launchId: record.launchId || null,
        lifecycle: { state: "sleeping", phase: null, percent: 0, since: record.sleptAt || null, phaseHistory: [] },
        capabilities: declaredCapabilities({ descriptor, record: stored, maxContext: 0 }),
        apiSurface: apiSurfaceOf(descriptor),
        sleep: {
          id,
          since: record.sleptAt || null,
          wakeable: record.hasConfig !== false,
          ...(record.reason ? { reason: record.reason } : {}),
        },
      };
    });
  }

  // A container whose engine this manager hosts; unknown engines are excluded
  // (stats scraping needs an engine it knows).
  const isKnownEngine = (container) => registry.hostedBy(managerId).includes(engineIdOf(container));

  return { isHosted, isKnownEngine, engineIdOf, typed, stateOf, sleeping };
}

module.exports = {
  createInstanceCatalog,
  engineIdOfContainer,
  isHostedContainer,
};
