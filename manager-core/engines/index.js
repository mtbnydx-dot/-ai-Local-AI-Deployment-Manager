"use strict";

// core.engines (00 §9.17): the engine subsystem is one namespace on manager-core
// instead of names spread into the flat export list, so later modules
// (param catalog, recipes, metrics, memory models) cannot collide with the
// older utilities. The runtime manifest identity helpers stay flat exports of
// runtime-manifest.js and are re-exposed here for engine code.
//
// resolveManifestRuntime is the manifest-only lookup (core.resolveRuntime): it
// ignores env image overrides (VLLM_IMAGE, SGLANG_IMAGE, LLAMA_IMAGE...) and
// runtimes.allowCustomImage. Launch code resolves through the registry
// (registry.resolveRuntime / runtimesFor), which applies both, so the image it
// runs is the one CONFIG runs today.

const descriptorSchema = require("./descriptor-schema");
const dockerSegments = require("./adapters/_docker-segments");
const registry = require("./registry");
const routes = require("./routes");
const runtimeManifest = require("../runtime-manifest");

// Adapter code modules by descriptor.adapter (01 §6). An engine whose adapter
// has no module here is not launchable through an adapter yet.
const adapters = Object.freeze({
  vllm: require("./adapters/vllm"),
  sglang: require("./adapters/sglang"),
  llamacpp: require("./adapters/llamacpp"),
});

/** descriptor (or its adapter id) -> adapter module, or null. */
function adapterFor(descriptorOrAdapterId) {
  const id = typeof descriptorOrAdapterId === "string" ? descriptorOrAdapterId : descriptorOrAdapterId?.adapter;
  return typeof id === "string" && Object.hasOwn(adapters, id) ? adapters[id] : null;
}

module.exports = {
  descriptorSchema,
  validateDescriptor: descriptorSchema.validateDescriptor,
  TIER1_ENGINE_IDS: descriptorSchema.TIER1_ENGINE_IDS,
  ENGINE_ID_PATTERN: descriptorSchema.ENGINE_ID_PATTERN,
  createEngineRegistry: registry.createEngineRegistry,
  getEngineRegistry: registry.getEngineRegistry,
  clearEngineRegistryCache: registry.clearEngineRegistryCache,
  unknownEngineError: registry.unknownEngineError,
  registerEngineRoutes: routes.registerEngineRoutes,
  buildEnginesPayload: routes.buildEnginesPayload,
  validateDraftRequest: routes.validateDraftRequest,
  // Engine adapters by descriptor `adapter` id (01 §6) and the one docker argv renderer.
  adapters,
  adapterFor,
  renderRunArgs: dockerSegments.renderRunArgs,
  listRuntimes: runtimeManifest.listRuntimes,
  resolveManifestRuntime: runtimeManifest.resolveRuntime,
  runtimeForImage: runtimeManifest.runtimeForImage,
  runtimeIdFor: runtimeManifest.runtimeIdFor,
};
