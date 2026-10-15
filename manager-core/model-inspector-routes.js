"use strict";

// Manager-side routes of the model inspector (docs/overhaul/02-models.md §17,
// "Manager endpoints"). Both managers call registerModelInspectorRoutes once
// with the facilities the later packages need, so those packages add their
// routes here without touching either server.js again:
//   MOD-5   GET  /api/knowledge/status   this manager's loader domains
//   MOD-13  POST /api/models/probe       needs docker, jobs, resolveModelPath
//   MOD-16  POST /api/qualify            needs jobs, listInstances
// The entry reaches these through the management proxy (/api/m/:managerId/*),
// which keeps the managers' own local-only gate for anything that writes.

const path = require("node:path");
const { normalizeManagerId } = require("./engines/registry");
const probe = require("./model-inspector/probe");
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
    // MOD-13: maps the request's model reference to a folder or .gguf file in this
    // manager's storage (storageResolver); `probe` holds test seams (runtimeFacts,
    // probeDir, inspect, now, sleep, pollMs, scriptsDir, containerName, timeoutMs).
    resolveModelPath: functionOrNull(deps.resolveModelPath),
    probe: deps.probe && typeof deps.probe === "object" ? deps.probe : {},
    // The background probe runs in flight, so a test (or a shutdown) can wait for them.
    probeRuns: new Set(),
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

function errorBody(code, message, hint, extra = {}) {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) }, ...extra };
}

/**
 * POST /api/models/probe {model, engineId, runtimeId?, allowRemoteCode?} -> 202
 * {ok, jobId, managerId}. The dry probe of 02 section 12 runs as a
 * `model-probe` job. Local-only like every manager write; a missing runtime
 * image is 409 runtime_image_missing with the Pull action and is never pulled.
 */
function probeHandler(context, inFlight) {
  return async (req, res) => {
    if (!context.isLocalRequest(req)) {
      return res.status(403).json(errorBody("forbidden", "The dry probe is only available to local callers."));
    }
    try {
      const started = await probe.startProbeJob(req.body, {
        ...context.probe,
        managerId: context.managerId,
        registry: context.registry,
        docker: context.docker,
        jobs: context.jobs,
        resolveModelPath: context.resolveModelPath,
        inFlight,
      });
      context.probeRuns.add(started.done);
      started.done.finally(() => context.probeRuns.delete(started.done));
      return res.status(202).json({ ok: true, jobId: started.job.id, managerId: context.managerId });
    } catch (error) {
      if (!(error instanceof probe.ProbeError)) {
        return res.status(500).json(errorBody("probe_failed", "The dry probe could not be started."));
      }
      const extra = {};
      if (error.action) extra.action = error.action;
      if (error.runtimeId) extra.runtimeId = error.runtimeId;
      if (error.jobId) extra.jobId = error.jobId;
      if (error.errors) extra.errors = error.errors;
      return res.status(error.status || 400).json(errorBody(error.code, error.message, error.hint, extra));
    }
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

  app.post("/api/models/probe", probeHandler(context, new Map()));

  return context;
}

module.exports = {
  buildKnowledgeStatusPayload,
  enginesDomain,
  launchParamsDomain,
  normalizeRouteDeps,
  registerModelInspectorRoutes,
};
