"use strict";

// core.models (docs/overhaul/02-models.md §3.1, 00 §9.17): the model inspector
// as one namespace on manager-core, exposed by a single line in
// manager-core/index.js and never spread into the flat export list, so no
// name here can collide with the older utilities. Later packages add their
// members (knowledge, parsers, compatibility, fit, ...) to this object.

const cache = require("./cache");
const cardSchema = require("./card-schema");
const contentDigest = require("./content-digest");
const evidence = require("./evidence");
const fit = require("./fit");
const inspect = require("./inspect");
const jsonSchemaLite = require("./json-schema-lite");
const knowledge = require("./knowledge");
const templateSignatures = require("./template-signatures");
const rangeReader = require("./remote/range-reader");
const role = require("./detectors/role");
const topology = require("./detectors/topology");

module.exports = {
  INSPECTOR_VERSION: inspect.INSPECTOR_VERSION,
  inspectLocal: inspect.inspectLocal,
  inspectLocalDetailed: inspect.inspectLocalDetailed,
  inspectRemote: inspect.inspectRemote,
  inspectRemoteDetailed: inspect.inspectRemoteDetailed,
  getCard: inspect.getCard,
  InspectError: inspect.InspectError,
  projectCard: cardSchema.projectCard,
  validateCard: cardSchema.validateCard,
  MODEL_CARD_SCHEMA: cardSchema.MODEL_CARD_SCHEMA,
  contentDigest: { forDir: contentDigest.contentDigestForDir },
  evidence: {
    addEvidence: evidence.addEvidence,
    confidenceOf: evidence.confidenceOf,
    CONFIDENCE_RANK: evidence.CONFIDENCE_RANK,
    CONFIDENCES: evidence.CONFIDENCES,
  },
  cache: {
    cardIdFor: cache.cardIdFor,
  ROLES: role.ROLES,
  detectRole: role.detectRole,
  pairCompanions: role.pairCompanions,
    canonicalRef: cache.canonicalRef,
    fingerprintLocal: cache.fingerprintLocal,
    readCachedFacts: cache.readCachedFacts,
    writeCachedFacts: cache.writeCachedFacts,
    defaultCacheDir: cache.defaultCacheDir,
  },
  cardIdFor: cache.cardIdFor,
  // The Range reader of 02 §6.1, for a hub reader that wraps or replaces it.
  remote: {
    readRange: rangeReader.readRange,
    createBudget: rangeReader.createBudget,
    TOTAL_BUDGET_MS: rangeReader.TOTAL_BUDGET_MS,
    REQUEST_TIMEOUT_MS: rangeReader.REQUEST_TIMEOUT_MS,
    DEFAULT_MAX_BYTES: rangeReader.DEFAULT_MAX_BYTES,
  },
  // Chat template signatures and parser resolution (02 8.3, 8.6, MOD-7).
  parsers: {
    matchTemplate: templateSignatures.matchTemplate,
    resolveParsers: templateSignatures.resolveParsers,
    resolveParsersSync: templateSignatures.resolveParsersSync,
    parserLists: templateSignatures.parserLists,
    readLocalTemplate: templateSignatures.readLocalTemplate,
    templateSha256: templateSignatures.templateSha256,
    CATALOG_IDS: templateSignatures.CATALOG_IDS,
  },
  // Memory fit (02 §10, MOD-9): artifact inputs for 01's memory models and grading.
  fit: {
    artifactMemoryInputs: fit.artifactMemoryInputs,
    kvBytes: fit.kvBytes,
    estimateFit: fit.estimateFit,
    legacyEstimate: fit.legacyEstimate,
    validateFitResult: fit.validateFitResult,
    resolveFitConstants: fit.resolveFitConstants,
    fitConstantsFromConfig: fit.fitConstantsFromConfig,
    FIT_CONSTANTS: fit.FIT_CONSTANTS,
    FIT_RESULT_SCHEMA: fit.FIT_RESULT_SCHEMA,
    MEMORY_POLICIES: fit.MEMORY_POLICIES,
  },
  tensorClasses: topology.DEFAULT_TENSOR_CLASSES,
  jsonSchema: { compileSchema: jsonSchemaLite.compileSchema, validate: jsonSchemaLite.validate },
  // Layered knowledge (02 §8, MOD-5). The loader reads the bundled data, the
  // owner's <AI_ROOT>/config/knowledge.d files and the engine descriptors'
  // error-signature additions; it never throws.
  knowledge: {
    load: knowledge.loadKnowledge,
    status: knowledge.knowledgeStatus,
    matchFamily: knowledge.matchFamily,
    errorSignatures: knowledge.errorSignatures,
    familyIdForCapabilityId: knowledge.familyIdForCapabilityId,
    registerStatusProvider: knowledge.registerStatusProvider,
    createLoader: knowledge.createKnowledgeLoader,
    getLoader: knowledge.getKnowledgeLoader,
    clearCache: knowledge.clearKnowledgeCache,
    checkRegexSafety: knowledge.checkRegexSafety,
    compileSafeRegex: knowledge.compileSafeRegex,
    prepareLogLines: knowledge.prepareLogLines,
    KINDS: knowledge.KINDS,
    LAYERS: knowledge.LAYERS,
  },
};
