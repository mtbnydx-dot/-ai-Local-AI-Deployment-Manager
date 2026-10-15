"use strict";

// Engine registry (docs/overhaul/01-engines.md §3-§5). Engines are data: the
// bundled descriptors in manager-core/data/engines/*.json, merged by id with
// <AI_ROOT>/config/engines/*.json overrides, and tied to the runtime manifest
// through runtimes.allowed. A broken override is reported in errors() and the
// bundled descriptor stays in force; loading never throws.

const fs = require("node:fs");
const path = require("node:path");
const { userDataDir } = require("../reference-data");
const runtimeManifest = require("../runtime-manifest");
const {
  ENGINE_ID_PATTERN,
  TIER1_ENGINE_IDS,
  UNKNOWN_ENGINE_ID,
  isImageEnvName,
  isImageReference,
  isPlainObject,
  validateDescriptor,
} = require("./descriptor-schema");

const BUNDLED_ENGINES_DIR = path.join(__dirname, "..", "data", "engines");

// API managerId (00 §3) and the ai.manager label values the managers use today.
const MANAGER_ALIASES = Object.freeze({
  vllm: "vllm",
  "vllm-manager": "vllm",
  llama: "llama",
  "llama-manager": "llama",
  entry: "entry",
  "service-entry": "entry",
});
// A legacy body with a missing or empty engine keeps today's default (01 §3).
const DEFAULT_ENGINE_BY_MANAGER = Object.freeze({ vllm: "vllm", llama: "llamacpp" });

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Overrides merge by id: objects merge key by key, arrays and scalars replace.
// Callers merge only validated input; the key guard is defence in depth.
function mergeDescriptor(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return clone(patch);
  const merged = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key)) continue;
    merged[key] = isPlainObject(value) && isPlainObject(merged[key]) ? mergeDescriptor(merged[key], value) : clone(value);
  }
  return merged;
}

function normalizeManagerId(managerId) {
  return MANAGER_ALIASES[String(managerId || "").trim().toLowerCase()] || "";
}

function unknownEngineError(engineId) {
  const shown = String(engineId ?? "").slice(0, 64);
  const error = new Error(`Unknown inference engine: ${shown || "(empty)"}`);
  error.status = 400;
  error.code = "unknown_engine";
  error.details = { engineId: shown };
  return error;
}

function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return { ok: true, value: JSON.parse(text.replace(/^﻿/, "")) };
  } catch (error) {
    return { ok: false, error };
  }
}

// A missing directory is normal (no overrides); any other failure is reported.
function listJsonFiles(dir) {
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(dir, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    return { files, error: null };
  } catch (error) {
    return { files: [], error: error.code === "ENOENT" ? null : error };
  }
}

function prefixErrors(errors, extra) {
  return errors.map((item) => ({ ...extra, ...item }));
}

/**
 * Ties runtimes.allowed to the manifest: every key must name a runtime of this
 * engine, and runtimes.default must be one of those, or the engine has no
 * default runtime and every legacy launch fails with unknown_runtime.
 * -> { refs, problems: [{ path, code, message, manifestKey }] }
 */
function resolveRuntimeKeys(descriptor, knownRuntimes) {
  const refs = [];
  const problems = [];
  const runtimes = isPlainObject(descriptor?.runtimes) ? descriptor.runtimes : null;
  if (!runtimes) return { refs, problems };
  for (const [index, manifestKey] of (Array.isArray(runtimes.allowed) ? runtimes.allowed : []).entries()) {
    const ref = knownRuntimes.get(manifestKey);
    const where = { path: `runtimes.allowed[${index}]`, manifestKey };
    if (!ref) {
      problems.push({ ...where, code: "unknown_runtime", message: `Runtime ${manifestKey} is not in the runtime manifest.` });
    } else if (ref.engineId !== descriptor.id) {
      problems.push({ ...where, code: "runtime_engine_mismatch", message: `Runtime ${manifestKey} (${ref.runtimeId}) belongs to engine ${ref.engineId}.` });
    } else {
      refs.push(ref);
    }
  }
  if (runtimes.default !== undefined && !refs.some((ref) => ref.manifestKey === runtimes.default)) {
    problems.push({
      path: "runtimes.default",
      manifestKey: runtimes.default,
      code: "default_runtime_unresolved",
      message: `runtimes.default ${runtimes.default} is not a runtime of engine ${descriptor.id}, so the engine would have no default runtime.`,
    });
  }
  return { refs, problems };
}

function publicProblem({ manifestKey: _manifestKey, ...problem }) {
  return problem;
}

// The runtime problems an override brings in: those of the merged descriptor
// that the descriptor it replaces did not have already. A bundled key that a
// runtime-manifest override broke stays the registry's problem, so an override
// that only changes the status is still applied.
function introducedRuntimeProblems(merged, base, knownRuntimes) {
  const problemKey = (problem) => `${problem.code}:${problem.manifestKey}`;
  const inherited = new Set(base ? resolveRuntimeKeys(base, knownRuntimes).problems.map(problemKey) : []);
  return resolveRuntimeKeys(merged, knownRuntimes).problems
    .filter((problem) => !inherited.has(problemKey(problem)))
    .map(publicProblem);
}

/**
 * One override entry (a file, an item of a list file, or a console draft)
 * against the engines loaded so far -> { ok, kind, errors, merged }. load() and
 * the side-effect-free draft check share it, so a draft is accepted exactly
 * when loading it as an override file would apply it. merged is frozen and
 * set only when ok.
 */
function evaluateOverride(entry, { mode, engines, knownRuntimes }) {
  let kind = "descriptor";
  try {
    const result = validateDescriptor(entry, { mode, knownIds: [...engines.keys()] });
    kind = result.kind;
    if (!result.ok) return { ok: false, kind, errors: result.errors, merged: null };
    const base = kind === "override" ? engines.get(entry.id) || null : null;
    const merged = base ? mergeDescriptor(base, entry) : clone(entry);
    // The merged result must still be a complete, coherent descriptor
    // (runtimes.default inside runtimes.allowed, and so on) whose runtimes
    // resolve in the manifest.
    let errors = validateDescriptor(merged, { mode: "bundled" }).errors;
    if (!errors.length) errors = introducedRuntimeProblems(merged, base, knownRuntimes);
    if (errors.length) return { ok: false, kind, errors, merged: null };
    return { ok: true, kind, errors: [], merged: deepFreeze(merged) };
  } catch (error) {
    // Only a pathological value gets here (nesting too deep to copy).
    return { ok: false, kind, errors: [{ path: "", code: "invalid_override", message: `The descriptor could not be checked: ${error.message}` }], merged: null };
  }
}

// The image an env override puts in a slot: the first variable of the
// envOverride entry that is set, through its template when it has one. The
// validators already limit names to image variables; this checks again, and a
// value that is not an image reference counts as unset, so no other variable
// (HF_TOKEN, an API key) can reach the API payload or docker's argv.
function envImageFor(spec, env) {
  const entries = Array.isArray(spec) ? spec : spec ? [spec] : [];
  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : entry?.env;
    if (!isImageEnvName(name)) continue;
    const value = String(env[name] || "").trim();
    if (!value) continue;
    const image = typeof entry?.template === "string" ? entry.template.replace("{value}", value) : value;
    if (!isImageReference(image)) continue;
    return { name, image };
  }
  return null;
}

/**
 * createEngineRegistry({ bundledDir?, overrideDir?, env?, manifest? })
 *
 * manifest defaults to the runtime-manifest module (bundled data plus its own
 * <AI_ROOT>/config override). env supplies the image overrides named in
 * descriptor runtimes.envOverride (VLLM_IMAGE, SGLANG_IMAGE, LLAMA_IMAGE...).
 */
function createEngineRegistry(options = {}) {
  const bundledDir = options.bundledDir || BUNDLED_ENGINES_DIR;
  const overrideDir = options.overrideDir || path.join(userDataDir(), "engines");
  const env = options.env || process.env;
  const manifest = options.manifest || runtimeManifest;
  // engines.native.enabled (01 §13, ENG-22): boolean or () => boolean. The
  // default reads platform.json through readSection("engines") on every call.
  const nativeSource = options.nativeEnabled;
  let state = null;

  function load(loadOptions = {}) {
    const errors = [];
    const engines = new Map();
    const bundledIds = [];
    const overrides = [];
    const manifestOptions = loadOptions.force ? { force: true } : {};
    const knownRuntimes = new Map(manifest.listRuntimes(manifestOptions).map((ref) => [ref.manifestKey, ref]));

    const bundled = listJsonFiles(bundledDir);
    if (bundled.error) errors.push({ source: "bundled", file: bundledDir, path: "", code: "unreadable", message: bundled.error.message });
    for (const file of bundled.files) {
      const read = readJsonFile(file);
      if (!read.ok) {
        errors.push({ source: "bundled", file, path: "", code: "invalid_json", message: read.error.message });
        continue;
      }
      const result = validateDescriptor(read.value, { mode: "bundled" });
      const engineId = typeof read.value?.id === "string" ? read.value.id : "";
      if (!result.ok) {
        errors.push(...prefixErrors(result.errors, { source: "bundled", file, engineId }));
        continue;
      }
      if (engines.has(engineId)) {
        errors.push({ source: "bundled", file, engineId, path: "id", code: "duplicate_engine", message: `Engine ${engineId} is defined twice.` });
        continue;
      }
      engines.set(engineId, read.value);
      bundledIds.push(engineId);
    }

    // A rejected override is dropped whole and the descriptor it would have
    // replaced stays in force (01 §4).
    const overrideFiles = listJsonFiles(overrideDir);
    if (overrideFiles.error) errors.push({ source: "override", file: overrideDir, path: "", code: "unreadable", message: overrideFiles.error.message });
    for (const file of overrideFiles.files) {
      const read = readJsonFile(file);
      if (!read.ok) {
        errors.push({ source: "override", file, path: "", code: "invalid_json", message: read.error.message });
        overrides.push({ file, engineId: "", applied: false });
        continue;
      }
      const entries = Array.isArray(read.value) ? read.value : [read.value];
      entries.forEach((entry, index) => {
        const where = Array.isArray(read.value) ? { file, index } : { file };
        const engineId = typeof entry?.id === "string" ? entry.id : "";
        const verdict = evaluateOverride(entry, { mode: "override", engines, knownRuntimes });
        if (!verdict.ok) {
          errors.push(...prefixErrors(verdict.errors, { source: "override", ...where, engineId }));
          overrides.push({ ...where, engineId, applied: false });
          return;
        }
        engines.set(engineId, verdict.merged);
        overrides.push({ ...where, engineId, applied: true, kind: verdict.kind });
      });
    }

    // Tie every engine to its manifest runtimes. Only a bundled descriptor can
    // still have a key that does not resolve (a runtime-manifest override broke
    // it); that key is reported and left out, and the engine stays usable.
    const runtimeRefs = new Map();
    for (const [engineId, descriptor] of engines) {
      const { refs, problems } = resolveRuntimeKeys(descriptor, knownRuntimes);
      errors.push(...prefixErrors(problems.map(publicProblem), { source: "registry", engineId }));
      runtimeRefs.set(engineId, refs);
    }
    for (const item of manifest.listRuntimeIdentityErrors(manifestOptions)) {
      errors.push({ source: "manifest", engineId: "", path: `runtimes.${item.manifestKey}`, code: item.code, message: item.message });
    }
    // A broken runtime-manifest override falls back to the bundled table; say so here too.
    const described = typeof manifest.describeRuntimeManifest === "function" ? manifest.describeRuntimeManifest(manifestOptions) : null;
    if (described?.error) {
      errors.push({ source: "manifest", file: described.userPath || "", engineId: "", path: "", code: "manifest_invalid", message: described.error });
    }

    // Built-ins first in their canonical order, then added engines by id.
    const rank = (engineId) => {
      const index = TIER1_ENGINE_IDS.indexOf(engineId);
      return index >= 0 ? index : TIER1_ENGINE_IDS.length;
    };
    const ordered = [...engines.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const frozen = new Map();
    for (const engineId of ordered) frozen.set(engineId, deepFreeze(engines.get(engineId)));
    state = {
      engines: frozen,
      bundledIds: Object.freeze(bundledIds),
      knownRuntimes,
      runtimeRefs,
      overrides: deepFreeze(overrides),
      errors: deepFreeze(errors),
      loadedAt: new Date().toISOString(),
    };
    return state;
  }

  function current() {
    return state || load();
  }

  function list() {
    return [...current().engines.values()];
  }

  function get(engineId) {
    return current().engines.get(String(engineId ?? "")) || null;
  }

  function has(engineId) {
    return current().engines.has(String(engineId ?? ""));
  }

  // No coercion: an id outside the pattern or not registered is 400 unknown_engine.
  function requireEngine(engineId) {
    const id = typeof engineId === "string" ? engineId : "";
    const descriptor = ENGINE_ID_PATTERN.test(id) ? get(id) : null;
    if (!descriptor) throw unknownEngineError(engineId);
    return descriptor;
  }

  function nativeEnabled() {
    if (typeof nativeSource === "function") return Boolean(nativeSource());
    if (typeof nativeSource === "boolean") return nativeSource;
    return require("./hosts/native").isNativeEnabled({ env });
  }

  // host.kinds without "native" while the flag is off, so the console and the
  // planner never offer a host that cannot run.
  function hostKindsFor(engineId) {
    const descriptor = typeof engineId === "object" && engineId ? engineId : get(engineId);
    const kinds = descriptor?.host?.kinds || [];
    return nativeEnabled() ? [...kinds] : kinds.filter((kind) => kind !== "native");
  }

  // host.default, or the first visible kind when the default is hidden.
  function defaultHostKindFor(engineId) {
    const descriptor = typeof engineId === "object" && engineId ? engineId : get(engineId);
    const kinds = hostKindsFor(descriptor);
    return kinds.includes(descriptor?.host?.default) ? descriptor.host.default : kinds[0] || "";
  }

  function hostedBy(managerId) {
    const host = normalizeManagerId(managerId);
    if (!host) return [];
    return list().filter((descriptor) => descriptor.hostManager === host).map((descriptor) => descriptor.id);
  }

  function defaultEngineFor(managerId) {
    const engineId = DEFAULT_ENGINE_BY_MANAGER[normalizeManagerId(managerId)] || "";
    return engineId && has(engineId) ? engineId : "";
  }

  /**
   * Legacy engine values (the `engine` body field, the ai.manager.engine label,
   * the instance `engine` field) → engineId (01 §3). Unknown values give
   * "unknown" so the instance is still listed and stoppable, never hidden.
   */
  function fromLegacy(value, managerId) {
    const text = String(value ?? "").trim().toLowerCase();
    const host = normalizeManagerId(managerId);
    if (!text) return defaultEngineFor(host) || UNKNOWN_ENGINE_ID;
    const hosted = list().filter((descriptor) => !host || descriptor.hostManager === host);
    const byLabel = hosted.find((descriptor) => descriptor.legacy?.engineLabel === text || descriptor.legacy?.managerEngineField === text);
    if (byLabel) return byLabel.id;
    if (ENGINE_ID_PATTERN.test(text) && has(text)) return text;
    // The llama label is unambiguous wherever it appears.
    const anywhere = list().find((descriptor) => descriptor.legacy?.engineLabel === text);
    return anywhere ? anywhere.id : UNKNOWN_ENGINE_ID;
  }

  function toLegacy(engineId) {
    const descriptor = get(engineId);
    return descriptor?.legacy?.engineLabel || String(engineId ?? "");
  }

  function effectiveRuntimeRef(descriptor, ref) {
    const override = envImageFor(descriptor.runtimes?.envOverride?.[ref.manifestKey] || ref.envOverride || null, env);
    // An env override replaces the slot's image and keeps its identity and
    // features, exactly as CONFIG.image = env || manifest does today.
    const image = override?.image || ref.image;
    return Object.freeze({
      ...ref,
      image,
      imageOverrideEnv: override && override.image !== ref.image ? override.name : null,
      default: descriptor.runtimes?.default === ref.manifestKey,
      pullPolicy: pullPolicy(descriptor, ref),
    });
  }

  /** The engine's runtimes in runtimes.allowed order, with env overrides applied. */
  function runtimesFor(engineId) {
    const descriptor = requireEngine(engineId);
    return (current().runtimeRefs.get(descriptor.id) || []).map((ref) => effectiveRuntimeRef(descriptor, ref));
  }

  function defaultRuntime(engineId) {
    return runtimesFor(engineId).find((ref) => ref.default) || null;
  }

  /**
   * Engine-scoped resolveRuntime: by runtimeId or manifest key within the
   * engine's allowed runtimes, or by image (an env-overridden slot image first,
   * then the manifest, then a custom image when the engine allows one).
   */
  function resolveRuntime(engineId, selector = {}) {
    const descriptor = requireEngine(engineId);
    const runtimes = runtimesFor(descriptor.id);
    const { runtimeId, manifestKey, image } = selector || {};
    let found = null;
    if (runtimeId) found = runtimes.find((ref) => ref.runtimeId === String(runtimeId));
    else if (manifestKey) found = runtimes.find((ref) => ref.manifestKey === String(manifestKey));
    else if (image) {
      const text = String(image).trim();
      found = runtimes.find((ref) => ref.image === text) || null;
      if (!found) {
        const known = manifest.runtimeForImage(text);
        const slot = known ? runtimes.find((ref) => ref.manifestKey === known.manifestKey) : null;
        // The manifest knows the image as this slot's runtime, but the slot runs
        // another image (an env override) or spells it differently: the ref
        // carries the image the caller asked for, since that is what is run.
        if (slot) return Object.freeze({ ...slot, image: text, imageOverrideEnv: null });
        if (!known && descriptor.runtimes?.allowCustomImage) {
          const custom = manifest.resolveRuntime(descriptor.id, { image: text });
          return Object.freeze({ ...custom, imageOverrideEnv: null, default: false, pullPolicy: pullPolicy(descriptor, custom) });
        }
      }
    } else {
      found = runtimes.find((ref) => ref.default) || null;
    }
    if (!found) {
      const error = new Error(`Unknown runtime for ${descriptor.id}: ${runtimeId || manifestKey || image || "(none)"}`);
      error.status = 404;
      error.code = "unknown_runtime";
      throw error;
    }
    return found;
  }

  /**
   * Pull policy per runtime (01 §5, 00 §9.2): "auto" (today's implicit pull
   * before the checkpoint) for a stable tier-1 engine's pinned runtimes, its
   * env image overrides and its custom images, all of which the managers pull
   * today; "explicit" for experimental engines and for unpinned, experimental
   * or retired manifest runtimes. Local builds keep "auto" here; a missing
   * local build is a runtime_local_build_missing blocker, not a pull.
   */
  function pullPolicy(descriptor, ref) {
    const engine = typeof descriptor === "string" ? get(descriptor) : descriptor;
    if (!engine || !ref) return "explicit";
    if (engine.tier !== 1 || engine.status !== "stable") return "explicit";
    return ref.custom || ref.status === "pinned" ? "auto" : "explicit";
  }

  /**
   * How load() would treat this entry as an override file, against the
   * current registry: { ok, kind, errors }. Nothing is written or changed.
   */
  function checkOverride(entry, { mode = "draft" } = {}) {
    const snapshot = current();
    const { ok, kind, errors } = evaluateOverride(entry, { mode, engines: snapshot.engines, knownRuntimes: snapshot.knownRuntimes });
    return { ok, kind, errors };
  }

  function errors() {
    return current().errors;
  }

  function status() {
    const snapshot = current();
    return {
      ok: snapshot.errors.length === 0,
      loadedAt: snapshot.loadedAt,
      bundledDir,
      overrideDir,
      engines: [...snapshot.engines.keys()],
      overrides: snapshot.overrides,
      errors: snapshot.errors,
    };
  }

  return {
    UNKNOWN_ENGINE_ID,
    bundledIds: () => current().bundledIds,
    checkOverride,
    defaultEngineFor,
    defaultHostKindFor,
    defaultRuntime,
    errors,
    fromLegacy,
    get,
    has,
    hostKindsFor,
    hostedBy,
    list,
    pullPolicy,
    // reload({ force: true }) also re-reads the runtime manifest.
    reload: (reloadOptions = {}) => {
      load(reloadOptions);
      return status();
    },
    require: requireEngine,
    resolveRuntime,
    runtimesFor,
    status,
    toLegacy,
  };
}

let defaultRegistry = null;

/** Process-wide registry over the bundled data and <AI_ROOT>/config/engines. */
function getEngineRegistry() {
  if (!defaultRegistry) defaultRegistry = createEngineRegistry();
  return defaultRegistry;
}

function clearEngineRegistryCache() {
  defaultRegistry = null;
}

module.exports = {
  BUNDLED_ENGINES_DIR,
  TIER1_ENGINE_IDS,
  UNKNOWN_ENGINE_ID,
  clearEngineRegistryCache,
  createEngineRegistry,
  getEngineRegistry,
  mergeDescriptor,
  normalizeManagerId,
  unknownEngineError,
};
