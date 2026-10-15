"use strict";

// core.models (docs/overhaul/02-models.md §3.1, 00 §9.17): the model inspector
// as one namespace on manager-core, exposed by a single line in
// manager-core/index.js and never spread into the flat export list, so no
// name here can collide with the older utilities. Later packages add their
// members (knowledge, parsers, compatibility, fit, ...) to this object.

const cache = require("./cache");
const capabilities = require("./capabilities");
const calibration = require("./calibration");
const cardEstimate = require("./card-estimate");
const cardSchema = require("./card-schema");
const compatibility = require("./compatibility");
const contentDigest = require("./content-digest");
const evidence = require("./evidence");
const fit = require("./fit");
const inspect = require("./inspect");
const jsonSchemaLite = require("./json-schema-lite");
const knowledge = require("./knowledge");
const managerHooks = require("./manager-hooks");
const observations = require("./observations");
const planFacts = require("./plan-facts");
const planner = require("./planner");
const probe = require("./probe");
const qualify = require("./qualify");
const hostRecords = require("./host-records");
const rootCause = require("./root-cause");
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
  // Published capabilities (02 section 16, MOD-18): the Instance.capabilities object and the fleet tokens.
  capabilities: {
    deriveCapabilities: capabilities.deriveCapabilities,
    capabilityTokens: capabilities.capabilityTokens,
    publishLaunchCapabilities: capabilities.publishLaunchCapabilities,
    annotateLocalModels: capabilities.annotateLocalModels,
    TOKEN_ORDER: capabilities.TOKEN_ORDER,
  },
  // Compatibility matrix (02 §9, MOD-11): one row per (engine, runtime) for a card.
  compatibility: {
    evaluateCompatibility: compatibility.evaluateCompatibility,
    ggufArchitectureSupport: compatibility.ggufArchitectureSupport,
    ROLE_TO_DESCRIPTOR: compatibility.ROLE_TO_DESCRIPTOR,
  },
  // Memory fit (02 §10, MOD-9): artifact inputs for 01's memory models and grading.
  fit: {
    artifactMemoryInputs: fit.artifactMemoryInputs,
    kvBytes: fit.kvBytes,
    estimateFit: fit.estimateFit,
    fitGrid: fit.fitGrid,
    fitMemoryInputs: fit.fitMemoryInputs,
    legacyEstimate: fit.legacyEstimate,
    validateFitResult: fit.validateFitResult,
    resolveFitConstants: fit.resolveFitConstants,
    fitConstantsFromConfig: fit.fitConstantsFromConfig,
    FIT_CONSTANTS: fit.FIT_CONSTANTS,
    FIT_RESULT_SCHEMA: fit.FIT_RESULT_SCHEMA,
    MEMORY_POLICIES: fit.MEMORY_POLICIES,
  },
  calibration: {
    createCalibrationStore: calibration.createCalibrationStore,
    calibrationFor: calibration.calibrationFor,
  },
  observations: { observationFromFacts: observations.observationFromFacts },
  // Plan facts and the per-manager hooks (02 §3.1, MOD-9b).
  planFacts: planFacts.planFacts,
  resolveCard: planFacts.resolveCard,
  managerHooks: managerHooks.managerHooks,
  // Root-cause classification of a failed start (02 §14, MOD-12).
  rootCause: {
    classifyFailure: rootCause.classifyFailure,
    legacyHint: rootCause.legacyHint,
    legacySuggestions: rootCause.legacySuggestions,
  },
  // Launch planner (02 §11, MOD-14): ranked, diversified plans per GPU set.
  planner: {
    planLaunches: planner.planLaunches,
    GOALS: planner.GOALS,
    PLANNER_CONSTANTS: planner.PLANNER_CONSTANTS,
  },
  // Pre-launch dry probe (02 section 12, MOD-13): sandboxed container per engine image.
  probe: {
    buildProbeCommand: probe.buildProbeCommand,
    runProbe: probe.runProbe,
    startProbeJob: probe.startProbeJob,
    probeKey: probe.probeKey,
    readProbeResult: probe.readProbeResult,
    listProbeResults: probe.listProbeResults,
    writeProbeResult: probe.writeProbeResult,
    defaultProbeDir: probe.defaultProbeDir,
    parseProbeOutput: probe.parseProbeOutput,
    PROBE_LABEL: probe.PROBE_LABEL,
    PROBE_MARKER: probe.PROBE_MARKER,
    PROBE_JOB_TYPE: probe.PROBE_JOB_TYPE,
  },
  // Qualification suite and host records (02 section 13, MOD-16): fixed checks against one
  // running instance, and the entry-owned record of the result.
  qualify: {
    runQualification: qualify.runQualification,
    startQualifyJob: qualify.startQualifyJob,
    planChecks: qualify.planChecks,
    buildHostRecord: qualify.buildHostRecord,
    createMetricsReader: qualify.createMetricsReader,
    requestFields: qualify.requestFields,
    runningQualification: qualify.runningQualification,
    summarizeResults: qualify.summarizeResults,
    CHECK_IDS: qualify.CHECK_IDS,
    LIGHT_CHECKS: qualify.LIGHT_CHECKS,
    QUALIFY_JOB_TYPE: qualify.QUALIFY_JOB_TYPE,
    QualifyError: qualify.QualifyError,
  },
  hostRecords: {
    createHostRecordStore: hostRecords.createHostRecordStore,
    normalizeHostRecord: hostRecords.normalizeHostRecord,
    pushHostRecord: hostRecords.pushHostRecord,
    withHostEvidence: hostRecords.withHostEvidence,
    evidenceForRecord: hostRecords.evidenceForRecord,
    recordCovers: hostRecords.recordCovers,
    summaryOf: hostRecords.summaryOf,
    HOST_RECORDS_PATH: hostRecords.HOST_RECORDS_PATH,
    PUSH_RETRY_DELAYS_MS: hostRecords.PUSH_RETRY_DELAYS_MS,
    MAX_RECORDS_PER_DIGEST: hostRecords.MAX_RECORDS_PER_DIGEST,
  },
  storageResolver: managerHooks.storageResolver,
  cardEstimate: {
    cardModeRequested: cardEstimate.cardModeRequested,
    buildCardEstimate: cardEstimate.buildCardEstimate,
    bodyToValues: cardEstimate.bodyToValues,
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
