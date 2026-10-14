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
const launchStore = require("./launch-store");
const legacyAliases = require("./legacy-aliases");
const memoryModels = require("./memory-models");
const metrics = require("./metrics");
const introspect = require("./introspect");
const runtimeFacts = require("./runtime-facts");
const paramCatalog = require("./param-catalog");
const recipeSchema = require("./recipe-schema");
const recipes = require("./recipes");
const registry = require("./registry");
const resolveLaunchPlanModule = require("./resolve-launch-plan");
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
  // Recipes as data (01 §10): the validator (02's save-as-recipe and the
  // console call recipeSchema.validateRecipe) and the loader.
  recipeSchema,
  validateRecipe: recipeSchema.validateRecipe,
  recipes,
  getRecipeStore: recipes.getRecipeStore,
  createRecipeStore: recipes.createRecipeStore,
  clearRecipeStoreCache: recipes.clearRecipeStoreCache,
  loadRecipes: recipes.loadRecipes,
  reloadRecipes: recipes.reloadRecipes,
  matchRecipes: recipes.matchRecipes,
  applyRecipe: recipes.applyRecipe,
  presetFromRecipe: recipes.presetFromRecipe,
  builtinProfiles: recipes.builtinProfiles,
  watchRecipeOverrides: recipes.watchRecipeOverrides,
  legacyBodyToRequest: legacyAliases.legacyBodyToRequest,
  legacyConfigToValues: legacyAliases.legacyConfigToValues,
  valuesToLegacyConfig: legacyAliases.valuesToLegacyConfig,
  legacyProfileToV2: legacyAliases.legacyProfileToV2,
  requestToLegacyRunOptions: legacyAliases.requestToLegacyRunOptions,
  // The launch-plan resolver (01 §11): POST /api/launch/plan and /api/start.
  launchPlan: resolveLaunchPlanModule,
  resolveLaunchPlan: resolveLaunchPlanModule.resolveLaunchPlan,
  planLaunch: resolveLaunchPlanModule.planLaunch,
  createLaunchPlanner: resolveLaunchPlanModule.createLaunchPlanner,
  // The only Prometheus parser and the canonical metric mapping (01 §16.1,
  // 00 §9.12): parsePrometheus, mapPrometheus and summarize for the 04
  // collector, the histogram helpers, and the per-manager instance sampler.
  metrics,
  // The one engine-side memory estimator (01 §12, 00 §9.1): 02 fit.js calls
  // memoryModels.estimate with artifact inputs and keys calibrations by
  // paramsKey(plan).
  memoryModels,
  estimateMemory: memoryModels.estimate,
  paramsKey: memoryModels.paramsKey,
  MEMORY_CONSTANTS: memoryModels.MEMORY_CONSTANTS,
  introspect,
  runtimeFacts,
  // Engine adapters by descriptor `adapter` id (01 §6) and the one docker argv renderer.
  adapters,
  adapterFor,
  renderRunArgs: dockerSegments.renderRunArgs,
  LAUNCH_LABEL_KEYS: dockerSegments.LAUNCH_LABEL_KEYS,
  // LaunchStore (01 §15): launch records, launch-id adoption and the wake plan.
  launchStore,
  createLaunchStore: launchStore.createLaunchStore,
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
