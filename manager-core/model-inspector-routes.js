"use strict";

// Manager-side routes of the model inspector (docs/overhaul/02-models.md §17,
// "Manager endpoints"). Both managers call registerModelInspectorRoutes once
// with the facilities the later packages need, so those packages add their
// routes here without touching either server.js again:
//   MOD-5   GET  /api/knowledge/status   this manager's loader domains
//   MOD-13  POST /api/models/probe       needs docker, jobs, dataDir
//   MOD-16  POST /api/qualify            needs jobs, listInstances
// The entry reaches these through the management proxy (/api/m/:managerId/*),
// which keeps the managers' own local-only gate for anything that writes.

const path = require("node:path");
const { normalizeManagerId } = require("./engines/registry");
const {
  collectStatusDomains, createPathDisplayer, defaultAiRoot, getKnowledgeLoader, registerStatusProvider,
} = require("./model-inspector/knowledge");

const JOB_FUNCTIONS = Object.freeze(["createJob", "appendLog", "finishJob", "failJob", "setJobProgress"]);

function functionOrNull(value) {
  return typeof value === "function" ? value : null;
}

/**
 * The deps a route needs, checked once: the manager (vllm | llama), the
 * local-request predicate (deny by default), the job functions of the
 * manager's jobs ledger, the docker runner, the instance lookup and the
 * manager's data directory.
 */
function normalizeRouteDeps(deps = {}) {
  const managerId = normalizeManagerId(deps.managerId);
  if (!managerId || managerId === "entry") throw new TypeError(`registerModelInspectorRoutes: unknown managerId ${deps.managerId}`);
  const jobSource = deps.jobs && typeof deps.jobs === "object" ? deps.jobs : deps;
  // The process-wide loader reads the descriptors' error-signature additions
  // from the registry this manager runs on.
  const knowledge = deps.knowledge || getKnowledgeLoader();
  if (!deps.knowledge && deps.registry) knowledge.setRegistry(deps.registry);
  return Object.freeze({
    managerId,
    isLocalRequest: typeof deps.isLocalRequest === "function" ? deps.isLocalRequest : () => false,
    jobs: Object.freeze(Object.fromEntries(JOB_FUNCTIONS.map((name) => [name, functionOrNull(jobSource[name])]))),
    docker: functionOrNull(deps.docker),
    listInstances: functionOrNull(deps.listInstances),
    dataDir: typeof deps.dataDir === "string" && deps.dataDir ? deps.dataDir : null,
    knowledge,
    registry: deps.registry || null,
    paramCatalog: deps.paramCatalog || null,
  });
}

function problemEntry(display, problem) {
  return {
    layer: problem.source === "override" ? "user" : "bundled",
    file: problem.file ? display(problem.file) : "",
    entryId: problem.engineId || problem.entryId || "",
    code: problem.code || "invalid",
    message: String(problem.message || ""),
    severity: "error",
  };
}

// A loader that is not a knowledge layer (engine descriptors, launch parameters)
// reports itself in the same domain shape: bundled files, user files, errors.
function loaderDomain(domain, { bundledDir, overrideDir, bundledFiles = [], overrideFiles = [], errors = [] }) {
  const display = createPathDisplayer({
    aiRoot: defaultAiRoot(),
    configDir: overrideDir ? path.dirname(overrideDir) : "",
    bundledDir: bundledDir ? path.dirname(bundledDir) : "",
  });
  const byFile = (file) => errors.filter((item) => item.file === file && item.code);
  const asFiles = (files, kind) => files.map((item) => ({
    name: path.basename(item.file),
    kind: item.kind || kind,
    entries: item.entries ?? 1,
    errors: byFile(item.file).map(({ entryId, engineId, code, message }) => ({ entryId: entryId || engineId || "", code, message: String(message || "") })),
    asOf: item.asOf || "",
    stale: false,
  }));
  return {
    domain,
    layers: [
      { layer: "bundled", path: bundledDir ? display(bundledDir) : "", files: asFiles(bundledFiles, "bundled") },
      { layer: "user", path: overrideDir ? display(overrideDir) : "", files: asFiles(overrideFiles, "override") },
    ],
    errors: errors.map((problem) => problemEntry(display, problem)),
  };
}

function enginesDomain(registry) {
  const status = registry.status();
  const bundledIds = typeof registry.bundledIds === "function" ? registry.bundledIds() : [];
  const applied = new Map();
  for (const item of status.overrides || []) {
    if (item.file && item.applied) applied.set(item.file, (applied.get(item.file) || 0) + 1);
  }
  const overrideFiles = [...new Set((status.overrides || []).map((item) => item.file).filter(Boolean))];
  return loaderDomain("engines", {
    bundledDir: status.bundledDir,
    overrideDir: status.overrideDir,
    bundledFiles: bundledIds.map((id) => ({ file: path.join(status.bundledDir, `${id}.json`), kind: "engine", entries: 1 })),
    overrideFiles: overrideFiles.map((file) => ({ file, kind: "override", entries: applied.get(file) || 0 })),
    errors: status.errors || [],
  });
}

function launchParamsDomain(catalog) {
  const status = catalog.status();
  const files = (status.files || []).filter((item) => item.file);
  return loaderDomain("launch-params", {
    bundledDir: status.bundledDir,
    overrideDir: status.overrideDir,
    bundledFiles: files.filter((item) => item.source === "bundled").map((item) => ({ file: item.file, kind: item.kind, asOf: item.asOf })),
    overrideFiles: files.filter((item) => item.source !== "bundled").map((item) => ({ file: item.file, kind: item.kind, asOf: item.asOf })),
    errors: status.errors || [],
  });
}

/**
 * The body of GET /api/knowledge/status: {ok: true, managerId, domains[], digest}.
 * Always usable: a domain that cannot be read is listed as {domain, unavailable: true}.
 */
function buildKnowledgeStatusPayload(context) {
  const domains = collectStatusDomains(context.knowledge);
  const models = domains.find((domain) => domain.domain === "models");
  return {
    ok: true,
    managerId: context.managerId,
    domains,
    digest: models?.digest || null,
  };
}

function registerModelInspectorRoutes(app, deps = {}) {
  const context = normalizeRouteDeps(deps);

  // The engine registry and the parameter catalog report through the same endpoint (02 §17).
  if (context.registry && typeof context.registry.status === "function") {
    registerStatusProvider("engines", () => enginesDomain(context.registry));
  }
  if (context.paramCatalog && typeof context.paramCatalog.status === "function") {
    registerStatusProvider("launch-params", () => launchParamsDomain(context.paramCatalog));
  }

  // Read-only, and always 200: a broken knowledge file is data in the answer, not an error status.
  app.get("/api/knowledge/status", (_req, res) => {
    let payload;
    try {
      payload = buildKnowledgeStatusPayload(context);
    } catch (error) {
      payload = {
        ok: true,
        managerId: context.managerId,
        domains: [{ domain: "models", unavailable: true, layers: [], errors: [{ file: "", entryId: "", code: "status_failed", message: String(error?.message || error) }] }],
        digest: null,
      };
    }
    if (typeof res.set === "function") res.set("Cache-Control", "no-store");
    res.status(200).json(payload);
  });

  return context;
}

module.exports = {
  buildKnowledgeStatusPayload,
  enginesDomain,
  launchParamsDomain,
  normalizeRouteDeps,
  registerModelInspectorRoutes,
};
