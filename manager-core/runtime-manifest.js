"use strict";

// Pinned runtime versions used to live as frozen literals inside
// vllm-manager/lib/runtime-compatibility.js and llama-manager/server.js.
// They now come from manager-core/data/runtime-manifest.json (with the same
// <AI_ROOT>/config override as the other reference tables), so an upgrade is a
// data change plus a validation run instead of an edit in three code paths.
// The literals below are the last known-good values and only guard against a
// missing or unreadable data file.

const path = require("node:path");
const { loadReferenceFile } = require("./reference-data");
// The image-variable allowlist is shared with descriptor runtimes.envOverride.
const { isImageEnvName } = require("./engines/descriptor-schema");

const MANIFEST_FILE = "runtime-manifest.json";
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ENGINE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const RUNTIME_STATUSES = Object.freeze(["pinned", "experimental", "retired", "unpinned"]);

// Identity fields (engineId, compatVersion, features) are stable facts about a
// runtime, so the fallback carries them. status is left to inference here: a
// user override that swaps a pinned digest for a tag must read as "unpinned"
// rather than inherit "pinned" from this table (docs/overhaul/01-engines.md §5).
const FALLBACK_RUNTIMES = Object.freeze({
  vllm: Object.freeze({
    label: "vLLM OpenAI server",
    engineId: "vllm",
    features: Object.freeze({ bitsAndBytesPlugin: false }),
    version: "v0.28.0",
    repository: "vllm/vllm-openai",
    manifestDigest: "sha256:61fc8a896b0a4fbbbdc063bc4b0dbc25ce98e02b5050c24aeb7830ac02039b14",
    platformDigest: "sha256:2286e8533ca8b6bc777594bae30524f1426ba46ca21797524e06df6a94b06635",
    platform: "linux/amd64",
    cudaVersion: "13.0.2",
    torchVersion: "2.13.0",
    transformersVersion: "5.15.1",
    bitsAndBytesPlugin: false,
    minimumComputeCapability: "7.5",
    minimumBlackwellCudaVersion: "12.8",
    minimumDriverVersions: Object.freeze({ win32: "580.88", linux: "580.65.06" }),
  }),
  vllmQwenMoe: Object.freeze({
    label: "vLLM nightly for Qwen3.6 MoE NVFP4",
    engineId: "vllm",
    version: "nightly-a16dbd5b",
    revision: "a16dbd5b8572d4128be9f10b9dcff4999b594b25",
    compatVersion: null,
    features: Object.freeze({ bitsAndBytesPlugin: false }),
    baseRuntime: "vllm",
    repository: "vllm/vllm-openai",
    manifestDigest: "",
    platformDigest: "sha256:754a391fb40c6106327042b97f4d3e32ec00376f3f3542bbc9fa9f4f06a95fbb",
    platform: "linux/amd64",
    transformersVersion: "5.12.1",
  }),
  vllmGemma: Object.freeze({
    label: "vLLM build for DiffusionGemma",
    engineId: "vllm",
    version: "v74b5964f",
    revision: "74b5964f02c7e023fadd3004cfac8a61c52eef1f",
    compatVersion: null,
    features: Object.freeze({ bitsAndBytesPlugin: false }),
    baseRuntime: "vllm",
    repository: "vllm/vllm-openai",
    manifestDigest: "",
    platformDigest: "sha256:9c719fc0c869092c7d0533f8357d6985a38d5ff03b20ffb6a4620c2b4806dd4b",
    platform: "linux/amd64",
    transformersVersion: "5.10.2",
  }),
  sglang: Object.freeze({
    label: "SGLang runtime",
    engineId: "sglang",
    features: Object.freeze({}),
    version: "0.5.17",
    repository: "lmsysorg/sglang",
    imageAliases: Object.freeze(["lmsysorg/sglang:latest-runtime"]),
    manifestDigest: "",
    platformDigest: "sha256:3ea7c6d74312d964edbcf9b3819425ea42117eb967ef1cfec632a70c926027df",
    platform: "linux/amd64",
    cudaVersion: "13.0",
    torchVersion: "2.11.0",
    transformersVersion: "5.12.1",
    minimumComputeCapability: "7.5",
    minimumBlackwellCudaVersion: "12.8",
    minimumDriverVersions: Object.freeze({ win32: "580.88", linux: "580.65.06" }),
  }),
  sglangFlashNext: Object.freeze({
    label: "SGLang Qwen3.8 Flash-Next SM120 (local build)",
    engineId: "sglang",
    compatVersion: "0.5.17",
    features: Object.freeze({ pleOffload: true, linearAttnBackends: true, mambaControls: true }),
    localBuild: true,
    image: "local/sglang:qwen38flashnext-sm120-dac5523d",
    version: "qwen38flashnext-sm120-dac5523d",
    baseRuntime: "sglang",
    transformersVersion: "5.12.1",
    minimumComputeCapability: "12.0",
    build: Object.freeze({
      context: "artifacts/build-sources/sglang-qwen38-sm120-dac5523d",
      dockerfile: "Dockerfile",
      script: "scripts/rebuild-sglang-flashnext.ps1",
    }),
  }),
  sglangPennyroyal: Object.freeze({
    label: "SGLang Pennyroyal v2.5.1 (RTX PRO 6000)",
    engineId: "sglang",
    compatVersion: null,
    features: Object.freeze({ pleOffload: true, nextnFrSpec: true }),
    image: "ghcr.io/jpezzulli/sglang-rtxpro6000:v2.5.1@sha256:76258532b1c01f7583fbe951f90b80903db931030291db9db4e5a68b28567866",
    repository: "ghcr.io/jpezzulli/sglang-rtxpro6000",
    version: "pennyroyal-v2.5.1",
    platform: "linux/amd64",
    minimumComputeCapability: "12.0",
  }),
  sglangFlashNextNvme: Object.freeze({
    label: "SGLang Flash-Next NVMe PLE (experimental local build)",
    engineId: "sglang",
    compatVersion: "0.5.17",
    features: Object.freeze({}),
    localBuild: true,
    experimental: true,
    image: "sglang-flashnext-sm120:local",
    version: "flashnext-nvme-ple-20260831",
    baseRuntime: "sglang",
    minimumComputeCapability: "12.0",
    build: Object.freeze({
      context: "artifacts/build-sources/qwen38-flashnext-rtx6000-20260831",
      dockerfile: "Dockerfile",
      script: "artifacts/build-sources/qwen38-flashnext-rtx6000-20260831/build.sh",
    }),
  }),
  llama: Object.freeze({
    label: "llama.cpp server (CUDA)",
    engineId: "llamacpp",
    features: Object.freeze({ reasoningEffort: true, mmprojDevice: true }),
    version: "b10630",
    build: 10630,
    image: "ghcr.io/ggml-org/llama.cpp@sha256:3e847b7b8d616411d4dd8f3d1a79caf02cc7a66b6b92c8212156ea73835bf7f3",
    repository: "ghcr.io/ggml-org/llama.cpp",
    platformDigest: "sha256:3e847b7b8d616411d4dd8f3d1a79caf02cc7a66b6b92c8212156ea73835bf7f3",
    platform: "linux/amd64",
  }),
  llamaMuse: Object.freeze({
    label: "llama.cpp Muse Glimmer (retired local build)",
    engineId: "llamacpp",
    compatVersion: null,
    features: Object.freeze({ reasoningEffort: false, mmprojDevice: false }),
    localBuild: true,
    retired: true,
    image: "local/llama.cpp:server-cuda-muse-62bf73d",
    version: "muse-62bf73d",
    revision: "62bf73d25c53b8161f8a22894d4f90c4aebbd7d0",
  }),
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function validateRuntimeManifest(data) {
  const errors = [];
  if (!data || typeof data !== "object") return { ok: false, errors: ["manifest is not an object"] };
  if (!data.runtimes || typeof data.runtimes !== "object") errors.push("runtimes must be an object");
  if (data.asOf && !Number.isFinite(Date.parse(data.asOf))) errors.push(`asOf is not a date: ${data.asOf}`);
  for (const [id, runtime] of Object.entries(data.runtimes || {})) {
    if (!runtime || typeof runtime !== "object") {
      errors.push(`${id}: entry must be an object`);
      continue;
    }
    if (!runtime.version && !runtime.image) errors.push(`${id}: needs version or image`);
    for (const key of ["manifestDigest", "platformDigest"]) {
      if (runtime[key] && !DIGEST_PATTERN.test(String(runtime[key]))) errors.push(`${id}.${key}: not a sha256 digest`);
    }
    if (!runtime.localBuild && !runtime.image && !runtime.repository) errors.push(`${id}: registry runtimes need repository`);
    if (runtime.image && /@sha256:/i.test(runtime.image) && !DIGEST_PATTERN.test(String(runtime.image).split("@")[1] || "")) {
      errors.push(`${id}.image: digest reference is malformed`);
    }
    if (runtime.localBuild && !runtime.retired && !runtime.build?.context) errors.push(`${id}: local builds must record build.context`);
    if (runtime.minimumDriverVersions && typeof runtime.minimumDriverVersions !== "object") errors.push(`${id}.minimumDriverVersions must be an object`);
    if (runtime.build && Number.isFinite(Number(runtime.build)) && typeof runtime.build !== "number") errors.push(`${id}.build must be a number when numeric`);
    // Identity fields added for the engine registry (01-engines §5); all optional
    // so older user overrides keep validating.
    if (runtime.engineId !== undefined && !ENGINE_ID_PATTERN.test(String(runtime.engineId))) errors.push(`${id}.engineId must match ${ENGINE_ID_PATTERN}`);
    if (runtime.status !== undefined && !RUNTIME_STATUSES.includes(runtime.status)) errors.push(`${id}.status must be one of ${RUNTIME_STATUSES.join(", ")}`);
    if (runtime.compatVersion !== undefined && runtime.compatVersion !== null && (typeof runtime.compatVersion !== "string" || !runtime.compatVersion.trim())) {
      errors.push(`${id}.compatVersion must be a non-empty string or null`);
    }
    if (runtime.features !== undefined) {
      if (!isPlainObject(runtime.features)) errors.push(`${id}.features must be an object`);
      else {
        for (const [name, value] of Object.entries(runtime.features)) {
          if (!["boolean", "string", "number"].includes(typeof value)) errors.push(`${id}.features.${name} must be a boolean, string or number`);
        }
      }
    }
    // The variable's value becomes the image shown by GET /api/engines and passed
    // to docker, so only image variables may be named, never HF_TOKEN or an API key.
    if (runtime.envOverride !== undefined && !isImageEnvName(runtime.envOverride)) {
      errors.push(`${id}.envOverride must name an image variable (*_IMAGE, *_IMAGE_VERSION, *_IMAGE_DIGEST or *_IMAGE_TAG)`);
    }
    // Native host binary (01 §13, ENG-22): a path below AI_ROOT and its sha256.
    if (runtime.native !== undefined) {
      if (!isPlainObject(runtime.native)) errors.push(`${id}.native must be an object`);
      else {
        const rel = String(runtime.native.path ?? "");
        const escapes = rel.split(/[\\/]+/).some((part) => part === ".." || part === "");
        if (!rel || escapes || path.isAbsolute(rel) || path.win32.isAbsolute(rel) || /[\u0000-\u001f]/.test(rel)) {
          errors.push(`${id}.native.path must be a path relative to the platform root`);
        }
        if (!/^(?:sha256:)?[0-9a-f]{64}$/i.test(String(runtime.native.sha256 ?? ""))) errors.push(`${id}.native.sha256 must be a sha256 hex digest`);
      }
    }
    if (runtime.imageAliases !== undefined && (!Array.isArray(runtime.imageAliases) || runtime.imageAliases.some((alias) => typeof alias !== "string" || !alias.trim()))) {
      errors.push(`${id}.imageAliases must be a list of image references`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeRuntimeEntry(fallback, override) {
  if (!override || typeof override !== "object") return fallback;
  return { ...(fallback || {}), ...override };
}

let manifestCache = null;

function loadRuntimeManifest(options = {}) {
  if (manifestCache && !options.force) return manifestCache;
  const loaded = loadReferenceFile(MANIFEST_FILE, options.now);
  const data = loaded.value && typeof loaded.value === "object" ? loaded.value : {};
  const validation = validateRuntimeManifest(loaded.value ? data : { runtimes: {} });
  const runtimes = {};
  const ids = new Set([...Object.keys(FALLBACK_RUNTIMES), ...Object.keys(data.runtimes || {})]);
  for (const id of ids) {
    runtimes[id] = deepFreeze(mergeRuntimeEntry(FALLBACK_RUNTIMES[id], validation.ok ? data.runtimes?.[id] : null));
  }
  const frozenRuntimes = Object.freeze(runtimes);
  manifestCache = Object.freeze({
    ...loaded,
    schemaVersion: Number(data.schemaVersion || 1),
    asOf: data.asOf || "",
    notes: data.notes || "",
    validation,
    // When the data file is broken we keep serving the fallback table but say so,
    // the same way reference-data reports an unparsable user override.
    usingFallback: !validation.ok || !loaded.ok,
    runtimes: frozenRuntimes,
    identity: buildRuntimeIdentity(frozenRuntimes),
  });
  return manifestCache;
}

function clearRuntimeManifestCache() {
  manifestCache = null;
}

// runtimeId = `${engineId}@${version}` (00 §3, 01 §3). A leading "v" is dropped
// only from dotted release numbers, so v0.28.0 gives vllm@0.28.0 while a commit
// build such as v74b5964f keeps its spelling (01 §5 lists vllm@v74b5964f).
function normalizeRuntimeVersion(version) {
  const text = String(version ?? "").trim();
  return text.replace(/^v(?=\d+\.\d)/i, "");
}

function runtimeIdFor(engineId, version) {
  const normalized = normalizeRuntimeVersion(version);
  return engineId && normalized ? `${engineId}@${normalized}` : "";
}

// An override entry without engineId inherits it from baseRuntime, then from
// the key prefix (sglang* → sglang, llama* → llamacpp, vllm* → vllm; 01 §22).
function inferRuntimeEngineId(key, runtime, runtimes, depth = 0) {
  if (runtime?.engineId) return String(runtime.engineId);
  const base = runtime?.baseRuntime ? runtimes[runtime.baseRuntime] : null;
  if (base && depth < 4 && runtime.baseRuntime !== key) {
    const inherited = inferRuntimeEngineId(runtime.baseRuntime, base, runtimes, depth + 1);
    if (inherited) return inherited;
  }
  if (/^sglang/i.test(key)) return "sglang";
  if (/^llama/i.test(key)) return "llamacpp";
  if (/^vllm/i.test(key)) return "vllm";
  return "";
}

// The upstream version used for since/until comparisons. An explicit value
// (including null for "unknown") wins; local builds inherit their base runtime.
function inferCompatVersion(key, runtime, runtimes, depth = 0) {
  if (runtime && Object.hasOwn(runtime, "compatVersion")) return runtime.compatVersion ?? null;
  const base = runtime?.baseRuntime ? runtimes[runtime.baseRuntime] : null;
  if (base && depth < 4 && runtime.baseRuntime !== key) return inferCompatVersion(runtime.baseRuntime, base, runtimes, depth + 1);
  const version = String(runtime?.version || "").trim();
  if (/^v?\d+\.\d+/i.test(version)) return normalizeRuntimeVersion(version);
  if (/^b\d+$/i.test(version)) return version.toLowerCase();
  return null;
}

function inferRuntimeStatus(runtime, image) {
  if (runtime?.status) return runtime.status;
  if (runtime?.retired) return "retired";
  if (runtime?.experimental) return "experimental";
  if (runtime?.localBuild) return "pinned";
  return /@sha256:[0-9a-f]{64}$/i.test(String(image || "")) ? "pinned" : "unpinned";
}

// The fields a runtime inherits from its base, as knownRuntimeImageMetadata
// assembled them in vllm-manager (base release first, own digests only).
function effectiveRelease(key, runtime, runtimes) {
  const base = runtime.baseRuntime && runtime.baseRuntime !== key ? runtimes[runtime.baseRuntime] : null;
  if (!base) return runtime;
  return deepFreeze({
    ...base,
    ...runtime,
    manifestDigest: runtime.manifestDigest || "",
    platformDigest: runtime.platformDigest || "",
  });
}

function imageReferenceOf(runtime) {
  if (!runtime) return "";
  if (runtime.image) return runtime.image;
  if (runtime.repository && runtime.platformDigest) return `${runtime.repository}@${runtime.platformDigest}`;
  if (runtime.repository && runtime.version) return `${runtime.repository}:${runtime.version}`;
  return "";
}

function buildRuntimeIdentity(runtimes) {
  const refs = new Map();
  const byRuntimeId = new Map();
  const errors = [];
  for (const [key, runtime] of Object.entries(runtimes)) {
    const engineId = inferRuntimeEngineId(key, runtime, runtimes);
    if (!engineId) {
      errors.push({ manifestKey: key, code: "runtime_engine_unknown", message: `${key}: no engineId and none can be inferred from baseRuntime or the key prefix` });
      continue;
    }
    const runtimeId = runtimeIdFor(engineId, runtime.version);
    if (!runtimeId) {
      errors.push({ manifestKey: key, code: "runtime_version_missing", message: `${key}: a runtimeId needs a version` });
      continue;
    }
    if (byRuntimeId.has(runtimeId)) {
      errors.push({ manifestKey: key, code: "duplicate_runtime_id", message: `${key}: runtimeId ${runtimeId} is already used by ${byRuntimeId.get(runtimeId)}` });
      continue;
    }
    byRuntimeId.set(runtimeId, key);
    const image = imageReferenceOf(runtime);
    refs.set(key, deepFreeze({
      manifestKey: key,
      runtimeId,
      engineId,
      label: runtime.label || key,
      image,
      version: normalizeRuntimeVersion(runtime.version),
      compatVersion: inferCompatVersion(key, runtime, runtimes),
      features: isPlainObject(runtime.features) ? { ...runtime.features } : {},
      status: inferRuntimeStatus(runtime, image),
      localBuild: Boolean(runtime.localBuild),
      envOverride: runtime.envOverride || null,
      native: isPlainObject(runtime.native) ? { path: String(runtime.native.path), sha256: String(runtime.native.sha256).replace(/^sha256:/i, "").toLowerCase() } : null,
      release: effectiveRelease(key, runtime, runtimes),
    }));
  }
  return Object.freeze({ refs, errors: Object.freeze(errors) });
}

/** Every runtime the manifest knows, in manifest order (01-engines §5). */
function listRuntimes(options = {}) {
  return [...loadRuntimeManifest(options).identity.refs.values()];
}

/** Manifest keys that do not map to exactly one runtimeId. */
function listRuntimeIdentityErrors(options = {}) {
  return loadRuntimeManifest(options).identity.errors;
}

function runtimeByKey(manifestKey, options = {}) {
  return loadRuntimeManifest(options).identity.refs.get(manifestKey) || null;
}

function parseImageReference(reference) {
  let text = String(reference || "").trim().toLowerCase();
  if (!text) return null;
  text = text.replace(/^(?:index\.)?docker\.io\//, "").replace(/^library\//, "");
  const at = text.indexOf("@");
  const digest = at >= 0 ? text.slice(at + 1) : "";
  const name = at >= 0 ? text.slice(0, at) : text;
  const colon = name.lastIndexOf(":");
  const tagged = colon > name.lastIndexOf("/");
  return {
    text,
    repository: tagged ? name.slice(0, colon) : name,
    tag: tagged ? name.slice(colon + 1) : "",
    digest,
  };
}

function imageCandidates(ref) {
  const release = ref.release || {};
  const candidates = [ref.image];
  if (release.repository && release.manifestDigest) candidates.push(`${release.repository}@${release.manifestDigest}`);
  if (release.repository && release.platformDigest) candidates.push(`${release.repository}@${release.platformDigest}`);
  // Only upstream releases publish their version as a tag (vllm/vllm-openai:v0.28.0).
  if (release.repository && release.version && !release.image && !release.baseRuntime) candidates.push(`${release.repository}:${release.version}`);
  if (Array.isArray(release.imageAliases)) candidates.push(...release.imageAliases);
  return candidates.map(parseImageReference).filter(Boolean);
}

function imageMatches(query, candidate) {
  if (query.text === candidate.text) return true;
  // The same repository and digest is the same image whether or not a tag rides along.
  return Boolean(query.digest && candidate.digest && query.digest === candidate.digest && query.repository === candidate.repository);
}

/** RuntimeRef for an image reference, or null for an image the manifest does not know. Replaces knownRuntimeImageMetadata. */
function runtimeForImage(imageRef, options = {}) {
  const query = parseImageReference(imageRef);
  if (!query) return null;
  for (const ref of listRuntimes(options)) {
    if (imageCandidates(ref).some((candidate) => imageMatches(query, candidate))) return ref;
  }
  return null;
}

function unknownRuntimeError(message) {
  const error = new Error(message);
  error.status = 404;
  error.code = "unknown_runtime";
  return error;
}

// An image the manifest does not know (a custom override): no feature is
// assumed, so every gated control reads as unsupported (01 §5 feature gating).
function customRuntimeRef(engineId, image) {
  const text = String(image || "").trim();
  return deepFreeze({
    manifestKey: null,
    runtimeId: `${engineId}@custom`,
    engineId,
    label: text,
    image: text,
    version: null,
    compatVersion: null,
    features: {},
    status: inferRuntimeStatus({}, text),
    localBuild: false,
    envOverride: null,
    release: null,
    custom: true,
  });
}

/** RuntimeRef for an engine by runtimeId, manifest key or image; throws { code: "unknown_runtime" }. */
function resolveRuntime(engineId, selector = {}, options = {}) {
  const { runtimeId, manifestKey, image } = selector || {};
  let ref = null;
  if (runtimeId) {
    ref = listRuntimes(options).find((item) => item.runtimeId === String(runtimeId)) || null;
  } else if (manifestKey) {
    ref = runtimeByKey(String(manifestKey), options);
  } else if (image) {
    ref = runtimeForImage(image, options);
    if (!ref) return customRuntimeRef(engineId, image);
  } else {
    throw unknownRuntimeError("A runtime is selected by runtimeId, manifestKey or image.");
  }
  if (!ref) throw unknownRuntimeError(`Unknown runtime: ${runtimeId || manifestKey}`);
  if (engineId && ref.engineId !== engineId) {
    throw unknownRuntimeError(`Runtime ${ref.runtimeId} belongs to engine ${ref.engineId}, not ${engineId}`);
  }
  return ref;
}

function getRuntimeRelease(id, options = {}) {
  const manifest = loadRuntimeManifest(options);
  return manifest.runtimes[id] || null;
}

function runtimeImageReference(id, options = {}) {
  return imageReferenceOf(getRuntimeRelease(id, options));
}

function resolveBuildPaths(runtime, aiRoot) {
  const root = aiRoot || process.env.AI_ROOT || path.resolve(__dirname, "..");
  const build = runtime?.build || {};
  const context = build.context ? path.resolve(root, build.context) : "";
  return {
    root,
    context,
    dockerfile: context ? path.join(context, build.dockerfile || "Dockerfile") : "",
    script: build.script ? path.resolve(root, build.script) : "",
  };
}

function describeRuntimeManifest(options = {}) {
  const manifest = loadRuntimeManifest(options);
  return {
    asOf: manifest.asOf,
    source: manifest.source,
    userPath: manifest.userPath,
    freshness: manifest.freshness,
    error: manifest.error || (manifest.validation.ok ? "" : manifest.validation.errors.join("; ")),
    usingFallback: manifest.usingFallback,
    identityErrors: manifest.identity.errors,
    runtimes: Object.entries(manifest.runtimes).map(([id, runtime]) => ({
      id,
      runtimeId: manifest.identity.refs.get(id)?.runtimeId || "",
      engineId: manifest.identity.refs.get(id)?.engineId || "",
      status: manifest.identity.refs.get(id)?.status || "",
      label: runtime.label || id,
      version: runtime.version || "",
      image: runtimeImageReference(id, options),
      localBuild: Boolean(runtime.localBuild),
      experimental: Boolean(runtime.experimental),
      retired: Boolean(runtime.retired),
      buildScript: runtime.build?.script || "",
      buildContext: runtime.build?.context || "",
      minimumComputeCapability: runtime.minimumComputeCapability || "",
      notes: Array.isArray(runtime.notes) ? runtime.notes : [],
    })),
  };
}

module.exports = {
  FALLBACK_RUNTIMES,
  RUNTIME_MANIFEST_FILE: MANIFEST_FILE,
  clearRuntimeManifestCache,
  describeRuntimeManifest,
  getRuntimeRelease,
  listRuntimeIdentityErrors,
  listRuntimes,
  loadRuntimeManifest,
  normalizeRuntimeVersion,
  resolveBuildPaths,
  resolveRuntime,
  RUNTIME_STATUSES,
  runtimeForImage,
  runtimeIdFor,
  runtimeImageReference,
  validateRuntimeManifest,
};
