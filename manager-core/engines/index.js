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
const expr = require("./expr");
const dockerHost = require("./hosts/docker");
const legacyAliases = require("./legacy-aliases");
const metrics = require("./metrics");
const introspect = require("./introspect");
const runtimeFacts = require("./runtime-facts");
const paramCatalog = require("./param-catalog");
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

// RuntimeHosts by kind (01 §13). Native (ENG-22) and external (ENG-19) join later.
const hosts = Object.freeze({
  docker: dockerHost,
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
  buildEngineSchemaPayload: routes.buildEngineSchemaPayload,
  validateDraftRequest: routes.validateDraftRequest,
  readInstanceMetrics: routes.readInstanceMetrics,
  // Parameter catalogs (01 §9), the expression language recipes and catalogs
  // share (01 §10.2), and the legacy alias table (01 §9.5).
  paramCatalog,
  createParamCatalog: paramCatalog.createParamCatalog,
  getParamCatalog: paramCatalog.getParamCatalog,
  loadCatalog: paramCatalog.loadCatalog,
  validateValues: paramCatalog.validateValues,
  expr,
  legacyAliases,
  legacyBodyToRequest: legacyAliases.legacyBodyToRequest,
  legacyConfigToValues: legacyAliases.legacyConfigToValues,
  valuesToLegacyConfig: legacyAliases.valuesToLegacyConfig,
  // The only Prometheus parser and the canonical metric mapping (01 §16.1,
  // 00 §9.12): parsePrometheus, mapPrometheus and summarize for the 04
  // collector, the histogram helpers, and the per-manager instance sampler.
  metrics,
  introspect,
  runtimeFacts,
  // Engine adapters by descriptor `adapter` id (01 §6) and the one docker argv renderer.
  adapters,
  adapterFor,
  renderRunArgs: dockerSegments.renderRunArgs,
  // RuntimeHosts (01 §13): DockerHost for Docker Desktop and docker in WSL,
  // configured by createDockerHostConfig (env > platform.json docker > Desktop).
  hosts,
  createDockerHost: dockerHost.createDockerHost,
  createDockerHostConfig: dockerHost.createDockerHostConfig,
  listRuntimes: runtimeManifest.listRuntimes,
  resolveManifestRuntime: runtimeManifest.resolveRuntime,
  runtimeForImage: runtimeManifest.runtimeForImage,
  runtimeIdFor: runtimeManifest.runtimeIdFor,
};
