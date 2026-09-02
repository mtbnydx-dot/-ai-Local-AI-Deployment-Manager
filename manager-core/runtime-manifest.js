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

const MANIFEST_FILE = "runtime-manifest.json";
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const FALLBACK_RUNTIMES = Object.freeze({
  vllm: Object.freeze({
    label: "vLLM OpenAI server",
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
  sglang: Object.freeze({
    label: "SGLang runtime",
    version: "0.5.17",
    repository: "lmsysorg/sglang",
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
  llama: Object.freeze({
    label: "llama.cpp server (CUDA)",
    version: "b10630",
    build: 10630,
    image: "ghcr.io/ggml-org/llama.cpp@sha256:3e847b7b8d616411d4dd8f3d1a79caf02cc7a66b6b92c8212156ea73835bf7f3",
    repository: "ghcr.io/ggml-org/llama.cpp",
    platformDigest: "sha256:3e847b7b8d616411d4dd8f3d1a79caf02cc7a66b6b92c8212156ea73835bf7f3",
    platform: "linux/amd64",
  }),
  llamaMuse: Object.freeze({
    label: "llama.cpp Muse Glimmer (retired local build)",
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
  }
  return { ok: errors.length === 0, errors };
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
  manifestCache = Object.freeze({
    ...loaded,
    schemaVersion: Number(data.schemaVersion || 1),
    asOf: data.asOf || "",
    notes: data.notes || "",
    validation,
    // When the data file is broken we keep serving the fallback table but say so,
    // the same way reference-data reports an unparsable user override.
    usingFallback: !validation.ok || !loaded.ok,
    runtimes: Object.freeze(runtimes),
  });
  return manifestCache;
}

function clearRuntimeManifestCache() {
  manifestCache = null;
}

function getRuntimeRelease(id, options = {}) {
  const manifest = loadRuntimeManifest(options);
  return manifest.runtimes[id] || null;
}

function runtimeImageReference(id, options = {}) {
  const runtime = getRuntimeRelease(id, options);
  if (!runtime) return "";
  if (runtime.image) return runtime.image;
  if (runtime.repository && runtime.platformDigest) return `${runtime.repository}@${runtime.platformDigest}`;
  if (runtime.repository && runtime.version) return `${runtime.repository}:${runtime.version}`;
  return "";
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
    runtimes: Object.entries(manifest.runtimes).map(([id, runtime]) => ({
      id,
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
  loadRuntimeManifest,
  resolveBuildPaths,
  runtimeImageReference,
  validateRuntimeManifest,
};
